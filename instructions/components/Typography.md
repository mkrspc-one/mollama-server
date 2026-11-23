COMPONENT: Typography

A piece of text with its own size, weight and colour. Only plain text goes inside: line breaks are joined into one line and tags inside are dropped.

Written as `<Typography>text</Typography>`. In a block layout several of them flow side by side like words; use as="p" to put one on its own line.

Sizes below hold at every window width from a tablet up; the steps from md up are smaller on a phone.

| Attribute | Values | What it does on screen |
|---|---|---|
| size | xxs, xs, sm, md, lg, xl, 2xl, 3xl, 4xl | Text height: 13, 14, 16, 18, 22, 28, 36, 48 and 64px. Default sm. |
| weight | thin, extralight, light, normal, medium, semibold, bold, extrabold, black | How heavy the letters are, from 100 to 900. Default normal. |
| color | default, muted, contrast, neutral, primary, secondary, tertiary (the theme's three colours), success, warning, error (usually green, amber and red, but each theme sets them) | Colour of the text. default is the normal text colour. muted is the same colour at 65%. contrast is for text on a filled box. |
| font | primary, secondary, monospace | The theme's main typeface, its second one, or one with letters of equal width. |
| as | p, span, h2, h3, h4, div | p, div and the headings start on their own line; span stays within the line. It does not change the size or weight: a heading still needs its own size and weight. |
| href | an https or mailto address | Makes the text a link that opens in a new tab. It looks like ordinary text until the mouse is over it, when it is underlined; give it a color so it reads as a link. Any other kind of address is ignored. |
| truncate | no value | Keeps the text on one line and ends it with … where it runs out of room. |

```component
<Typography as="p" size="2xl" weight="bold" color="primary">42%</Typography>
```
