COMPONENT: Card

A panel: white (the theme's panel colour), with a thin border and rounded corners, flat on the page. Like a Container it arranges the components inside it.

Written as `<Card> ... </Card>`.

| Attribute | Values | What it does on screen |
|---|---|---|
| bordered | true, false | true (default) draws the thin border. false removes it. |
| borderColor | primary, secondary, tertiary | Colour of the border. |
| borderStrength | normal, soft | soft makes the border fainter. |
| radius | sm, md, lg, xl | Corner rounding: 8px, 14px, 20px or 28px. Without it the theme decides. |
| shadow | true, false | true adds a soft shadow under the panel. Default false. |
| hover | true, false | The border darkens while the mouse is over the panel, and with shadow="true" the shadow deepens. |
| layout | block, flex, flex-column, grid | How the components inside are arranged. **block** (the default): each Card, Container, Button, Divider, ProgressBar, Input, Select and Switch takes a full line, while Typography, Badge, Icon and CircularProgress flow side by side like words. **flex**: side by side in a row that wraps. **flex-column**: stacked top to bottom. **grid**: equal-width columns. |
| columns | 1 to 6, or auto, auto-sm, auto-lg | For grid. A number gives that many equal columns. auto fits as many columns of at least 250px as there is room for (auto-sm 200px, auto-lg 300px). In a Container, numbered columns reduce on narrow windows: one column at 640px wide or less, at most two up to 900px, at most three up to 1200px. In a Card they never reduce. |
| gap | none 0, xs 4px, sm 8px, md 12px, lg 16px, xl 24px | Space between the components inside. It only has an effect in flex, flex-column and grid, not in block. Default sm. |
| padding | none 0, xs 4px, sm 8px, md 12px, lg 16px, xl 24px | Space between the edge of the box and what is inside. Default md (12px). |
| justify | start, center, end, between, around, evenly | Position along the layout direction (across a flex row, down a flex-column). between: first at one edge, last at the other, equal space between. around: equal space on both sides of each. evenly: all spaces equal, edges included. In block layout only start, center and end work. |
| align | start, center, end, stretch, baseline | Position across the layout direction. Default start, so things in a row line up at the top and keep their own heights; stretch makes them equal height; baseline lines up their text. No effect in block. |
| wrap | true, false | For flex. true (default) lets a row continue on a new line; false keeps one line. |
| flexFill | no value | Inside a flex box, this box takes all the space left over. |
| width, height, minWidth, minHeight, maxWidth | a CSS length with its unit, such as 100% or 240px | Size of the box. A box written at the top of a block is only as wide as its content unless given width="100%". |
| backgroundColor | surface, background, primary, secondary, tertiary, neutral | Fills the box. surface is the panel colour, background the page colour. The text inside does not change colour, so on a primary, secondary or tertiary fill give Typography color="contrast". |
| background | grid, graph, dots, lines, diagonal, crosshatch, checker, hex, plus, waves, zigzag, rings, aurora, gradient | A faint pattern behind the contents. grid: thin lines both ways. graph: a finer grid with a stronger line every fifth cell. dots: one dot per cell. lines: horizontal rules. diagonal: thin 45° lines. crosshatch: both diagonals. checker: checkerboard. hex: honeycomb. plus: a small plus in each cell. waves and zigzag: wavy or zigzag lines. rings: rings spreading from the centre. aurora: six soft blobs of the theme's colours drifting slowly. gradient: one band of colour sweeping across. |
| backgroundIntensity | subtle, medium, strong | How visible the pattern is: 12%, 22% or 40% of its colour. Default subtle. |
| backgroundSize | sm, md, lg | Cell size of the pattern: 16px, 24px or 40px. Default md. No effect on aurora or gradient. |
| backgroundTone | auto, primary, secondary, tertiary, neutral, text, contrast | Colour of the pattern. auto (default) picks one that shows on the fill. |
| backgroundMotion | none, drift, pulse | drift slides the pattern one cell every 8 seconds (rings ripple outward). pulse fades it in and out every 5 seconds. aurora and gradient always move unless this is none. |
| backgroundFade | none, radial, radial-inverse, top, bottom, left, right, center | Where the pattern fades away. radial: strong in the middle, gone at the edges. radial-inverse: clear in the middle, stronger at the edges. top, bottom, left, right: it fades out toward that side. center: shows at the left and right edges, clear in the middle. |

```component
<Card layout="flex-column" gap="sm" width="100%">
  <Container layout="flex" justify="between" align="center" width="100%">
    <Typography weight="bold">Server status</Typography>
    <Badge color="success">Online</Badge>
  </Container>
  <ProgressBar value="72" label="Disk used" showPercentage />
</Card>
```
A panel with a bold title and a badge on one line, and a labelled bar filled to 72% under them.
