COMPONENT: Editor

A panel that shows text which cannot be edited. It has three looks, chosen by mode.

Written as `<Editor mode="...">text</Editor>` with the text between the tags, or as `<Editor src="https://..." />` to show a file.

| Attribute | Values | What it does on screen |
|---|---|---|
| mode | markdown, document, code | **markdown** (also what you get with no mode): the text is Markdown, drawn formatted in a bordered box up to 70% of the window tall, which scrolls inside. **document**: a white page like a printed sheet with wide side margins; the text must be **HTML** (`<h1>`, `<p>`, `<b>`, `<ul><li>`, `<table>`), because Markdown symbols would show as typed. **code**: a code panel with line numbers and colours, its language named in the corner beside a copy button; it is as tall as its lines, from 2 up to 24, and scrolls beyond that. |
| language | python, javascript, typescript, jsx, tsx, json, html, css, bash, powershell, sql, java, c, cpp, csharp, go, rust, ruby, php, yaml, xml, markdown, swift, kotlin (and the short forms py, js, ts, sh, cs, yml, md) | For code mode: decides the colours. Any other name still shows the code, uncoloured. |
| src | the https address of a text, Markdown or code file | Shows that file. A file ending .md is shown as Markdown; anything else as code, coloured by the end of its name unless language says otherwise. Text past 200,000 characters is left out. |

In markdown mode you can use headings, bold and italics, bulleted and numbered lists, quotes, links, images, tables, rules and fenced code blocks. A code fence may name js, jsx, ts, tsx, html, css, json, md, txt, bash, sh, python, sql, yaml, ruby, go, rust, c, cpp or java. Maths goes in a fence named math, written in LaTeX; it is drawn as a formula. A wide table scrolls sideways.

The user can scroll and select text in every mode, and copy all of the code with the copy button. There is no download, search or print button. A file from src has a "Source:" link under it.

```component
<Editor mode="code" language="python">
def area(r):
    return 3.14159 * r * r
</Editor>
```

```component
<Editor mode="document">
<h1>Meeting notes</h1>
<ul><li>Budget approved</li><li>Launch moved to March</li></ul>
</Editor>
```
