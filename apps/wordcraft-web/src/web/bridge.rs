//! `window.aiword`: the control channel for the page, as promises.
//!
//! The same JSON methods as the desktop control channel (`crates/ui-egui/src/control.rs`), so the
//! assistant panel next to the editor (`studio/`) drives AI-Word with the commands the CLI and the
//! MCP server use:
//!
//! ```js
//! await aiword.execute("text.insert", {text: "Привет"})   // a command → its result
//! await aiword.request("document.inspect")                // a control method → its result
//! await aiword.commands()                                 // every command with its params doc
//! const {png} = await aiword.screenshot()                 // the window as PNG (base64)
//! aiword.open("Приказ.docx", bytes)                       // open a document (Uint8Array)
//! await aiword.addFont("times.ttf", bytes)                // a font for every document
//! aiword.wantsKeyboard()                                  // a text field has the keyboard
//! ```
//!
//! Results resolve with the method's `result`; errors reject with an `Error`. Save and Save As
//! reach the page as an `aiword:save` event on `window` (`detail: {name, path, saveAs, bytes}`),
//! and whether the document has unsaved changes as `aiword:dirty` (`detail: {dirty}`).

use std::cell::RefCell;
use std::sync::mpsc::{Receiver, Sender, TryRecvError};

use serde_json::{Value, json};
use wasm_bindgen::JsCast as _;
use wasm_bindgen::prelude::*;
use wordcraft_ui_egui::{ControlRequest, Inbox};

/// The most requests the page may have waiting at once (a runaway script can't fill the memory).
const MAX_WAITING: usize = 256;

/// The largest document or font the page may hand over at once.
const MAX_FILE_BYTES: u32 = 512 * 1024 * 1024;

type Waiting = (Receiver<Value>, js_sys::Function, js_sys::Function);

struct Link {
    requests: Sender<ControlRequest>,
    inbox: Inbox,
    ctx: egui::Context,
}

thread_local! {
    static LINK: RefCell<Option<Link>> = const { RefCell::new(None) };
    static WAITING: RefCell<Vec<Waiting>> = const { RefCell::new(Vec::new()) };
}

/// Connect the page to the running app: where its requests go, the inbox documents open from,
/// and the context to wake for a frame.
pub fn connect(requests: Sender<ControlRequest>, inbox: Inbox, ctx: egui::Context) {
    LINK.with(|l| *l.borrow_mut() = Some(Link { requests, inbox, ctx }));
}

fn repaint() {
    LINK.with(|l| {
        if let Some(link) = l.borrow().as_ref() {
            link.ctx.request_repaint();
        }
    });
}

fn to_js(v: &Value) -> JsValue {
    js_sys::JSON::parse(&v.to_string()).unwrap_or(JsValue::NULL)
}

fn from_js(v: &JsValue) -> Value {
    if v.is_undefined() || v.is_null() {
        return json!({});
    }
    js_sys::JSON::stringify(v).ok().and_then(|s| s.as_string()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}))
}

fn error(message: &str) -> JsValue {
    js_sys::Error::new(message).into()
}

/// Settle the promises of answered requests (after each frame, and on a timer).
pub fn poll_replies() {
    WAITING.with(|w| {
        w.borrow_mut().retain(|(rx, resolve, reject)| match rx.try_recv() {
            Ok(reply) => {
                if reply.get("ok").and_then(Value::as_bool) == Some(true) {
                    let _ = resolve.call1(&JsValue::NULL, &to_js(reply.get("result").unwrap_or(&Value::Null)));
                } else {
                    let message = reply.get("error").and_then(Value::as_str).unwrap_or("the request failed");
                    let _ = reject.call1(&JsValue::NULL, &error(message));
                }
                false
            }
            Err(TryRecvError::Empty) => true,
            Err(TryRecvError::Disconnected) => {
                let _ = reject.call1(&JsValue::NULL, &error("request dropped"));
                false
            }
        });
    });
}

fn request(method: &str, params: Value) -> js_sys::Promise {
    let p = js_sys::Promise::new(&mut |resolve, reject| {
        if WAITING.with(|w| w.borrow().len()) >= MAX_WAITING {
            let _ = reject.call1(&JsValue::NULL, &error("too many requests waiting"));
            return;
        }
        let (req, rx) = ControlRequest::new(method, params.clone());
        let sent = LINK.with(|l| l.borrow().as_ref().map(|link| link.requests.send(req).is_ok()));
        match sent {
            Some(true) => WAITING.with(|w| w.borrow_mut().push((rx, resolve, reject))),
            Some(false) => {
                let _ = reject.call1(&JsValue::NULL, &error("AI-Word has closed"));
            }
            None => {
                let _ = reject.call1(&JsValue::NULL, &error("AI-Word is not running yet"));
            }
        }
    });
    repaint();
    p
}

/// The bytes of a `Uint8Array` or `ArrayBuffer`, within [`MAX_FILE_BYTES`].
fn bytes_of(v: &JsValue) -> Result<Vec<u8>, JsValue> {
    let array = if let Some(a) = v.dyn_ref::<js_sys::Uint8Array>() {
        a.clone()
    } else if v.is_instance_of::<js_sys::ArrayBuffer>() {
        js_sys::Uint8Array::new(v)
    } else {
        return Err(error("bytes must be a Uint8Array or an ArrayBuffer"));
    };
    if array.length() > MAX_FILE_BYTES {
        return Err(error("the file is too large"));
    }
    Ok(array.to_vec())
}

/// A file name the page passed: trimmed, at most 255 characters, `fallback` when empty.
fn clean_name(name: &str, fallback: &str) -> String {
    let name: String = name.trim().chars().take(255).collect();
    if name.is_empty() { fallback.to_string() } else { name }
}

/// Open a document the page has (from the server's files): it replaces the open document on the
/// next frame, after the Save Changes prompt when that one has unsaved changes.
fn open(name: String, bytes: JsValue) -> Result<(), JsValue> {
    let bytes = bytes_of(&bytes)?;
    let name = clean_name(&name, "Документ.docx");
    LINK.with(|l| {
        let link = l.borrow();
        let link = link.as_ref().ok_or_else(|| error("AI-Word is not running yet"))?;
        link.inbox.lock().unwrap_or_else(|e| e.into_inner()).push((name, bytes));
        link.ctx.request_repaint();
        Ok(())
    })
}

/// Add a font for every document (the metric-compatible fonts shipped with the page, and the
/// fonts an organisation keeps on its server). Resolves with the families added; a font whose
/// faces are all available already resolves with an empty list.
fn add_font(name: String, bytes: JsValue) -> Result<JsValue, JsValue> {
    let bytes = bytes_of(&bytes)?;
    let name = clean_name(&name, "font.ttf");
    let added = match wordcraft_fonts::FontDb::global().install_font(&name, &bytes) {
        Ok(installed) => to_js(&json!({ "families": installed.font.families() })),
        Err(wordcraft_fonts::UserFontError::AlreadyAvailable(_)) => to_js(&json!({ "families": [] })),
        Err(e) => return Err(error(&format!("{name}: {e}"))),
    };
    repaint();
    Ok(added)
}

/// Install a spelling dictionary the page fetched (Hunspell `.aff` and `.dic` text).
fn add_dictionary(lang: String, aff: String, dic: String) -> Result<(), JsValue> {
    const MAX_TEXT: usize = 64 * 1024 * 1024;
    if aff.len() > MAX_TEXT || dic.len() > MAX_TEXT {
        return Err(error("the dictionary is too large"));
    }
    wordcraft_proof::install_dictionary(&lang, &aff, &dic).map_err(|e| error(&e))?;
    repaint();
    Ok(())
}

fn set(obj: &js_sys::Object, name: &str, f: JsValue) -> Result<(), JsValue> {
    js_sys::Reflect::set(obj, &name.into(), &f).map(|_| ())
}

/// Tell the page something happened (`aiword:<what>` on `window`, with `detail`).
fn notify(what: &str, detail: &JsValue) -> Result<(), String> {
    let window = web_sys::window().ok_or("no window")?;
    let init = web_sys::CustomEventInit::new();
    init.set_detail(detail);
    let event = web_sys::CustomEvent::new_with_event_init_dict(&format!("aiword:{what}"), &init).map_err(|e| format!("{e:?}"))?;
    window.dispatch_event(&event).map(|_| ()).map_err(|e| format!("{e:?}"))
}

/// Saves go to the page while it listens (it keeps them in the user's files on the server).
pub fn save_to_page(name: &str, path: Option<&str>, bytes: &[u8], named: bool) -> Result<bool, String> {
    if !listening() {
        return Ok(false);
    }
    let detail = js_sys::Object::new();
    let put = |k: &str, v: &JsValue| js_sys::Reflect::set(&detail, &k.into(), v).map(|_| ()).map_err(|e| format!("{e:?}"));
    put("name", &name.into())?;
    put("path", &path.map_or(JsValue::NULL, JsValue::from_str))?;
    put("saveAs", &named.into())?;
    put("bytes", &js_sys::Uint8Array::from(bytes).into())?;
    notify("save", &detail.into())?;
    Ok(true)
}

/// Whether the page said it takes saves (`aiword.listen(true)`).
fn listening() -> bool {
    web_sys::window()
        .and_then(|w| js_sys::Reflect::get(&w, &"aiword".into()).ok())
        .and_then(|o| js_sys::Reflect::get(&o, &"takesSaves".into()).ok())
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Whether the document has unsaved changes, told to the page when it changes.
pub fn dirty(now: bool) {
    thread_local! {
        static LAST: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
    }
    if LAST.with(|l| l.replace(Some(now))) != Some(now) {
        let _ = notify("dirty", &to_js(&json!({ "dirty": now })));
    }
}

/// Install `window.aiword` and the timer that settles its promises.
pub fn install() -> Result<(), JsValue> {
    let obj = js_sys::Object::new();
    set(
        &obj,
        "request",
        Closure::<dyn Fn(String, JsValue) -> js_sys::Promise>::new(|method: String, params: JsValue| request(&method, from_js(&params)))
            .into_js_value(),
    )?;
    set(
        &obj,
        "execute",
        Closure::<dyn Fn(String, JsValue) -> js_sys::Promise>::new(|command: String, params: JsValue| {
            request("engine.execute", json!({ "command": command, "params": from_js(&params) }))
        })
        .into_js_value(),
    )?;
    set(&obj, "commands", Closure::<dyn Fn() -> js_sys::Promise>::new(|| request("engine.commands", json!({}))).into_js_value())?;
    set(&obj, "inspect", Closure::<dyn Fn() -> js_sys::Promise>::new(|| request("ui.inspect", json!({}))).into_js_value())?;
    set(&obj, "screenshot", Closure::<dyn Fn() -> js_sys::Promise>::new(|| request("ui.screenshot", json!({}))).into_js_value())?;
    set(&obj, "open", Closure::<dyn Fn(String, JsValue) -> Result<(), JsValue>>::new(open).into_js_value())?;
    set(&obj, "addDictionary", Closure::<dyn Fn(String, String, String) -> Result<(), JsValue>>::new(add_dictionary).into_js_value())?;
    set(&obj, "addFont", Closure::<dyn Fn(String, JsValue) -> Result<JsValue, JsValue>>::new(add_font).into_js_value())?;
    set(
        &obj,
        "wantsKeyboard",
        Closure::<dyn Fn() -> bool>::new(|| LINK.with(|l| l.borrow().as_ref().is_some_and(|link| link.ctx.text_edit_focused()))).into_js_value(),
    )?;
    set(&obj, "takesSaves", JsValue::FALSE)?;
    set(&obj, "product", JsValue::from_str("AI-Word"))?;
    let w = web_sys::window().ok_or("no window")?;
    js_sys::Reflect::set(&w, &"aiword".into(), &obj)?;
    let tick = Closure::<dyn Fn()>::new(poll_replies).into_js_value();
    w.set_interval_with_callback_and_timeout_and_arguments_0(tick.unchecked_ref(), 40)?;
    Ok(())
}
