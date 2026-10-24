<?php
// studio/api/tools.php — что помощник AI-Word знает о себе и какие действия ему разрешены.
//
// Инструменты выполняет БРАУЗЕР (studio.js): только он видит запущенный
// редактор. Сервер лишь объявляет модели, какие инструменты есть, и решает,
// какие из них доступны в текущем режиме.

/** Инструменты, которые ничего не меняют в документе. Доступны в обоих режимах. */
function studio_read_tools(): array
{
    return [
        [
            'type' => 'function',
            'function' => [
                'name' => 'find_commands',
                'description' => 'Найти команды редактора по смыслу (по-русски или по-английски). '
                    . 'Возвращает id команды, русское название, путь на ленте, горячую клавишу и описание параметров. '
                    . 'Вызывай перед run_command, если не знаешь точный id: id нельзя угадывать.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'query' => ['type' => 'string', 'description' => 'Что нужно сделать, 1–4 слова: «межстрочный интервал», «поля», «оглавление», «нумерация страниц», «table».'],
                    ],
                    'required' => ['query'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'get_state',
                'description' => 'Текущее состояние документа: имя, сохранён ли, число страниц и слов, поля и размер страницы, '
                    . 'абзацы (номер, стиль, начало текста, отступы, интервалы, шрифт), выделение.',
                'parameters' => ['type' => 'object', 'properties' => new stdClass()],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'read_document',
                'description' => 'Прочитать текст документа целиком или кусок: абзацы с номерами. Нужен, чтобы пересказать, проверить, найти что-то или отредактировать.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'from' => ['type' => 'integer', 'description' => 'С какого абзаца (с 0), по умолчанию 0'],
                        'count' => ['type' => 'integer', 'description' => 'Сколько абзацев, по умолчанию все (до 400)'],
                    ],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'paragraph_details',
                'description' => 'Всё оформление одного абзаца: стиль и его свойства, шрифт и размер, выравнивание, отступы, интервалы (в пунктах).',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'index' => ['type' => 'integer', 'description' => 'Номер абзаца из get_state или read_document'],
                    ],
                    'required' => ['index'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'look_at_screen',
                'description' => 'Сделать снимок экрана редактора и посмотреть на него: проверить результат или увидеть, как выглядит страница.',
                'parameters' => ['type' => 'object', 'properties' => new stdClass()],
            ],
        ],
    ];
}

/** Инструменты, которые меняют документ. Только в режиме «Сделай». */
function studio_act_tools(): array
{
    return [
        [
            'type' => 'function',
            'function' => [
                'name' => 'run_command',
                'description' => 'Выполнить команду редактора с параметрами. Диалогов нет: всё задаётся параметрами. '
                    . 'Действует на выделение (или на абзац с курсором). Действие отменяется (Ctrl+Z).',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'id' => ['type' => 'string', 'description' => 'id команды, например select.text, para.set, styles.modify, layout.margins, text.insert'],
                        'params' => ['type' => 'object', 'description' => 'Параметры команды (JSON-объект). Можно не передавать — тогда значения по умолчанию.'],
                    ],
                    'required' => ['id'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'apply_gost',
                'description' => 'Оформить весь документ по ГОСТ одним шагом: поля, шрифт, размер, межстрочный интервал, абзацный отступ, выравнивание по ширине, '
                    . 'нумерация страниц. Значения по умолчанию — типичные (ГОСТ Р 7.0.97 / 7.32): поля 30/15/20/20 мм, Times New Roman 14, интервал 1,5, отступ 1,25 см.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'font' => ['type' => 'string', 'description' => 'Шрифт, по умолчанию Times New Roman'],
                        'size' => ['type' => 'number', 'description' => 'Кегль, пт, по умолчанию 14'],
                        'lineSpacing' => ['type' => 'number', 'description' => 'Межстрочный (множитель), по умолчанию 1.5'],
                        'indentCm' => ['type' => 'number', 'description' => 'Абзацный отступ, см, по умолчанию 1.25'],
                        'marginsMm' => ['type' => 'object', 'description' => '{left, right, top, bottom} в мм, по умолчанию 30, 15, 20, 20'],
                        'pageNumbers' => ['type' => 'string', 'description' => '"bottom-center" (по умолчанию), "top-center", "bottom-right" или "none"'],
                    ],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'undo',
                'description' => 'Отменить последние действия (как Ctrl+Z).',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'steps' => ['type' => 'integer', 'description' => 'Сколько шагов отменить, по умолчанию 1', 'minimum' => 1, 'maximum' => 20],
                    ],
                ],
            ],
        ],
    ];
}

/** Системная инструкция. $mode: 'advice' (Совет) или 'act' (Сделай). */
function studio_system_prompt(string $mode): string
{
    $available = $mode === 'act' ? array_merge(studio_read_tools(), studio_act_tools()) : studio_read_tools();
    $catalog = studio_tool_catalog($available);

    $common = <<<TXT
Ты — встроенный помощник AI-Word, текстового редактора, устроенного как Microsoft Word: лента (Главная, Вставка, Макет,
Ссылки, Рецензирование, Вид), стили, списки, таблицы, колонтитулы, оглавление, рецензирование; интерфейс на русском.
Документы — .docx (а также .doc, .odt, .rtf); файлы пользователя хранятся на его сервере («Мои файлы»).
Пользователь работает в редакторе прямо сейчас. К его сообщению приложено состояние документа, а иногда снимок экрана.

Как отвечать:
- Всегда по-русски, коротко и по делу: 1–6 предложений или короткий нумерованный список шагов.
- Пункты ленты пиши так: «Главная › Абзац › Интервал». Горячие клавиши — в скобках: (Ctrl+B). Сочетания — как в Word.
- Названия команд бери из find_commands, а не по памяти. Не выдумывай функций, которых нет.
- Размеры: 1 см = 28,35 пт, 1 мм = 2,835 пт; в командах отступы и поля — в пунктах (pt).
- Сохранение: Ctrl+S сохраняет документ в «Мои файлы» на сервере (значок папки в панели помощника).
- Когда просят проверить оформление по методичке или ГОСТ — смотри реальные значения (get_state, paragraph_details), а не снимок экрана.

Твои инструменты (других нет — ни computer_use, ни кликов по координатам):
{$catalog}
Вызывай их штатно. Если штатный вызов недоступен, напиши вызов текстом, по одному блоку на вызов:
<tool_call><function=ИМЯ><parameter=КЛЮЧ>ЗНАЧЕНИЕ</parameter></function></tool_call>
Значения-объекты и списки пиши в JSON. После блока ничего не пиши — дождись результата.
TXT;

    if ($mode === 'act') {
        return $common . "\n\n" . <<<TXT
Режим «Сделай»: ты сам правишь документ с помощью инструментов.
Это главное правило: не объясняй пользователю, как сделать вручную, — сделай сам. Если раньше в разговоре
ты был в режиме «Совет» и писал, что не можешь ничего менять, — это больше не так: сейчас режим «Сделай».
Каждое сообщение пользователя начинается с пометки текущего режима — верь ей.
Порядок работы:
1. Пойми задачу. Если она неоднозначна и ошибка дорого стоит — задай один уточняющий вопрос.
2. Посмотри документ: состояние приложено к сообщению; текст — read_document; оформление абзаца — paragraph_details.
3. Команды действуют на выделение, поэтому сначала выдели, потом меняй:
   - выделить: select.all {} (весь текст), select.text {text, occurrence?} (фрагмент), select.paragraph {} (абзац с курсором);
     select.range {anchor: {"story":"body","path":[N],"off":0}, focus: {"story":"body","path":[M],"off":0}} — абзацы с N по M (off — смещение в байтах);
   - текст: text.insert {text} (вставить в место курсора, заменяет выделение), text.newParagraph {}, edit.replaceAll {text, with};
   - шрифт: format.font {name}, format.size {size}, format.bold / format.italic / format.underline {};
   - абзац: para.set {props: {align: "left|center|right|justify", indentLeft, indentRight, indentFirst (пт; отрицательный — выступ),
     spaceBefore, spaceAfter (пт), lineSpacing: {"rule":"multiple","value":1.5} | {"rule":"exactly","value":18} | {"rule":"atLeast","value":12}}};
   - стили (меняют все абзацы этого стиля сразу — лучший способ оформить документ целиком):
     styles.modify {style: "Normal", chr: {font: "Times New Roman", size: 14}, para: {align: "justify", indentFirst: 35.43, lineSpacing: {"rule":"multiple","value":1.5}, spaceBefore: 0, spaceAfter: 0}};
     применить стиль к абзацу: para.style {style: "Heading1"}; заголовки: para.heading1 / para.heading2 / para.heading3;
   - страница: layout.margins {top, bottom, left, right} (пт); layout.size {name: "A4"}; layout.orientation;
   - списки: para.bullets {}, para.numbering {}; таблица: insert.table {rows, cols};
   - колонтитулы и номера страниц: insert.pageNumber {position: "bottom", align: "center"}; insert.header {text};
   - оглавление: references.toc {} (по стилям заголовков), обновить: references.updateToc {};
   - разрыв страницы: text.pageBreak {}.
   Оформление по ГОСТ целиком — инструмент apply_gost.
   Если не знаешь id команды или её параметры — find_commands.
4. После заметных изменений проверь результат (get_state или look_at_screen) и коротко скажи, что сделал и как отменить (Ctrl+Z).
Правила безопасности:
- Не создавай новый документ, не открывай и не закрывай файлы, не удаляй большие куски текста, если пользователь прямо об этом не просил.
- Делай не больше 12 действий подряд; если задача больше — сделай часть и спроси, продолжать ли.
- Если команда вернула ошибку — не повторяй вслепую: прочитай ошибку и params_doc, поправь параметры или объясни, что мешает.
TXT;
    }

    return $common . "\n\n" . <<<TXT
Режим «Совет»: ты только объясняешь и подсказываешь, ничего не меняешь сам.
Можно искать команды (find_commands), читать документ (read_document, get_state, paragraph_details) и смотреть на экран (look_at_screen).
Объясняй, куда нажать и что выставить, с конкретными числами. Можешь пересказать документ, найти в нём нужное, проверить текст и оформление.
Если пользователь просит изменить документ за него — скажи, что для этого нужно переключиться в режим «Сделай» (кнопка вверху панели).
TXT;
}

/**
 * Каталог инструментов текстом — для системной подсказки. Некоторые шлюзы (например, vLLM без
 * парсера вызовов) не передают модели поле tools; тогда модель узнаёт о наших инструментах
 * только отсюда и пишет вызовы текстом.
 */
function studio_tool_catalog(array $tools): string
{
    $lines = [];
    foreach ($tools as $t) {
        $f = $t['function'] ?? [];
        $name = (string)($f['name'] ?? '');
        if ($name === '') {
            continue;
        }
        $params = [];
        foreach (($f['parameters']['properties'] ?? []) as $p => $spec) {
            $params[] = $p . ': ' . ($spec['type'] ?? 'string');
        }
        $lines[] = '- ' . $name . '(' . implode(', ', $params) . ') — ' . (string)($f['description'] ?? '');
    }
    return implode("\n", $lines);
}

/**
 * Вызовы инструментов, которые модель написала текстом, а не штатным полем tool_calls:
 *   <tool_call><function=ИМЯ><parameter=КЛЮЧ>ЗНАЧЕНИЕ</parameter>…</function></tool_call>  (Qwen)
 *   <tool_call>{"name": "ИМЯ", "arguments": {…}}</tool_call>                             (Hermes)
 * Возвращает [вызовы, текст без этих блоков].
 */
function studio_text_tool_calls(string $content): array
{
    $calls = [];
    $value = static function (string $raw) {
        $raw = trim($raw);
        $j = json_decode($raw, true);
        return ($j !== null || $raw === 'null') ? $j : $raw;
    };
    // Qwen XML: с обёрткой <tool_call> или без неё. Прокси с vLLM иногда «съедает» начало
    // вызова («<tool_call>\n<»), и приходит «function=run_command>…» — это тоже понимаем,
    // как и вызов без закрывающих тегов в конце ответа.
    if (preg_match_all('~(?:<tool_call>\s*)?<?function=([A-Za-z0-9_.\-]+)>(.*?)(?:</function>(?:\s*</tool_call>)?|(?=<?function=[A-Za-z0-9_.\-]+>)|\z)~s', $content, $m, PREG_SET_ORDER)) {
        foreach ($m as $one) {
            $args = [];
            if (preg_match_all('~<?parameter=([A-Za-z0-9_.\-]+)>(.*?)(?:</parameter>|(?=<?parameter=[A-Za-z0-9_.\-]+>)|(?=</function>)|\z)~s', $one[2], $pm, PREG_SET_ORDER)) {
                foreach ($pm as $p) {
                    $args[$p[1]] = $value($p[2]);
                }
            }
            $calls[] = ['function' => ['name' => $one[1], 'arguments' => $args ?: new stdClass()]];
            $content = str_replace($one[0], '', $content);
        }
    }
    // Hermes: JSON внутри <tool_call>.
    if (preg_match_all('~<tool_call>\s*(\{.*?\})\s*</tool_call>~s', $content, $m, PREG_SET_ORDER)) {
        foreach ($m as $one) {
            $j = json_decode($one[1], true);
            if (is_array($j) && isset($j['name'])) {
                $args = $j['arguments'] ?? ($j['parameters'] ?? []);
                if (is_string($args)) {
                    $args = json_decode($args, true) ?: [];
                }
                $calls[] = ['function' => ['name' => (string)$j['name'], 'arguments' => $args ?: new stdClass()]];
                $content = str_replace($one[0], '', $content);
            }
        }
    }
    // Рассуждения модели в ответ не нужны.
    $content = preg_replace('~<think>.*?</think>~s', '', $content) ?? $content;
    $content = trim(str_replace(['<tool_call>', '</tool_call>'], '', $content));
    return [$calls, $content];
}
