COMPONENT: Flow

A diagram: boxes joined by connectors, on a canvas the user can move around and zoom. It is drawn on windows at least 768px wide; on a narrower one the user sees a notice asking for a tablet or desktop instead.

Written as `<Flow> ... </Flow>` holding Node, Edge and Group tags, one per line.

| Attribute | Values | What it does on screen |
|---|---|---|
| height | a CSS length with its unit, such as 100% or 240px | How tall the diagram is. Default 380px, never less than 300px. It is always as wide as the reply. |
| arrange | lr, tb, grid, circle | How boxes with no x and y are placed. lr (default): columns from left to right following the connectors. tb: rows from top to bottom. grid: a plain grid. circle: around a circle. Boxes are spaced by their real sizes, so they never overlap, and each connector runs between the facing sides of its two boxes. |
| minimap | no value | Opens the small overview map at the start. The user can also open it from the toolbar. |
| background | dots, lines, cross, none | The pattern on the canvas. Default dots. |

### Node: one box

| Attribute | Values | What it does on screen |
|---|---|---|
| id | a short name of your own | Required and unique. Edges refer to it. A second Node with the same id is ignored. |
| label | text, which may be Markdown | What the box says. Without it the id is shown. See "What a label can hold" below. |
| color | primary, secondary, tertiary, success, warning, error, neutral, surface, background | Fill of the box. The first seven fill it with that colour and write in the contrast colour. surface and background are light fills with normal text and a thin outline. Default primary. |
| shape | rectangle, circle, diamond, cylinder | rectangle (default): at least 72×32px, wraps text at 320px wide. circle: at least 100×100, text up to 180px wide. diamond: at least 100×100, text up to 200px wide. cylinder: at least 120×64, a drum with a darker band on top, text up to 260px wide. Only the outline is shaped, so long text spills out of a circle or diamond: keep those labels short. |
| size | xs, sm, md, lg, xl, 2xl | Size of the text in the box. |
| weight | light, normal, medium, semibold, bold, extrabold | Weight of the text. Default semibold. |
| align | left, center, right | Which side the text lines up on. Default center. |
| width, height | a number of pixels, such as 220 | A fixed size for the box. Without them the box fits its text. |
| x, y | numbers of pixels | Places the box yourself, measured from the top left. Give both. When any box has x, nothing is arranged automatically, so place every box. |
| group | the id of a Group | Puts the box inside that group. |

### Edge: one connector

| Attribute | Values | What it does on screen |
|---|---|---|
| source, target | ids of Nodes | Required. The connector runs from source to target, with an arrowhead at the target. An Edge naming a box that does not exist is left out. |
| label | plain text | Shown in a small tag on the middle of the connector. Markdown is not used here. |
| type | smoothstep, step, straight, default, simplebezier | The line. smoothstep (default): right angles with rounded corners. step: right angles with sharp corners. straight: one straight line. default: a smooth S-curve. simplebezier: a gentler curve. |
| color | primary, secondary, tertiary, success, warning, error, neutral | Colour of the line and arrowhead. Default primary. |
| arrow | filled, open, none | The head at the target: a filled triangle (default), an open V, or none. |
| start | filled, open | Adds a head at the source too, for a two-way connector. |
| dashed | true | A dashed line. |
| animated | true | Dashes that move along the line toward the target. |
| width | 1 to 10 | Thickness in pixels. Default 2. |
| labelsize | sm, md, lg | Size of the label's text: small (default), 12px or 15px. |
| labelbg | false | Removes the tag behind the label, leaving bare text. |
| from, to | top, right, bottom, left | Which side of the source the line leaves and which side of the target it enters. Only used when you place the boxes yourself with x and y. |
| bend | 0 to 100 | For the right-angled lines: how far along the turn happens, as a percentage. |
| corner | 0 to 40 | For smoothstep: how rounded the corners are, in pixels. |

### Group: a labelled frame around boxes

Written as `<Group id="g" label="Gearbox" />`. Boxes join it with group="g". When arranged, the frame is sized to fit its boxes.

| Attribute | Values | What it does on screen |
|---|---|---|
| id | a short name of your own | Required. Nodes refer to it with group. |
| label | text | The title at the top of the frame. |
| color | primary, secondary, tertiary, success, warning, error, neutral | Tint of the frame. Default neutral. |
| collapsible | true | Gives the frame a control to fold away its boxes. |
| collapsed | true | Starts folded. |
| x, y, width, height | numbers of pixels | Place and size, when you place things yourself. Default size 300×200. |

### What a label can hold

A label is Markdown. Inside the quotes write a new line as `&#10;`, a double quote as `&quot;`, and `<` `>` `&` as `&lt;` `&gt;` `&amp;`. A label can be up to 4,000 characters.

| Content | Written as | What it looks like |
|---|---|---|
| Bold, italics, strikethrough, inline code | `**bold** *italic* ~~gone~~ \`code\`` | Drawn as such. Inline code is in a monospace face on a tint. |
| Line break | `First&#10;Second` | A new line in the box. |
| Headings | `# Title&#10;text` | A larger, heavier first line: # largest, ## and ### smaller. |
| Lists | `- one&#10;- two` or `1. one&#10;2. two` | Bulleted or numbered, left-aligned, at normal weight. Indent with two spaces to nest. `- [ ] task` gives a tick box. |
| Table | `| Gear | Ratio |&#10;|---|---|&#10;| 1st | 3.5 |` | A small table with ruled cells. The box grows as wide as the table needs. |
| Code block | `~~~js&#10;const a = 1;&#10;~~~` | A left-aligned block in a monospace face on a tint. Lines do not wrap, so the box grows to the longest line. It is not coloured by language. |
| Quote | `> a remark` | A bar at the left and slightly faded text. |
| Link | `[docs](https://example.com)` | Underlined, opens in a new tab. |
| Rule | `above&#10;&#10;---&#10;&#10;below` | A thin line across the box. |

Images, HTML tags and maths are not drawn in a label.

### What the user can do

Drag the canvas to move around, scroll or pinch to zoom, and use the small toolbar at the left: zoom in, zoom out, fit everything, show or hide the overview map. While the pointer is over the diagram the scroll wheel zooms it instead of scrolling the chat. The diagram opens fitted to the window. The user cannot move, edit or add anything.

```component
<Flow height="420px">
  <Group id="box" label="Gearbox" />
  <Node id="engine" label="**Engine**&#10;- burns fuel&#10;- turns the crank" />
  <Node id="clutch" label="Clutch" shape="diamond" color="warning" />
  <Node id="gears" label="| Gear | Ratio |&#10;|---|---|&#10;| 1st | 3.5 |&#10;| 5th | 0.8 |" color="surface" group="box" />
  <Node id="wheels" label="Wheels" shape="circle" color="success" />
  <Edge source="engine" target="clutch" label="power" />
  <Edge source="clutch" target="gears" label="when engaged" dashed="true" color="warning" />
  <Edge source="gears" target="wheels" animated="true" color="success" width="3" />
</Flow>
```
A box with a bold title and two bullets, an amber diamond, a framed group holding a small table, and a green circle, joined left to right by a plain arrow, a dashed amber one and a thick green one with moving dashes.

Up to 500 boxes and 1,000 connectors. A Flow with no Node is not drawn.
