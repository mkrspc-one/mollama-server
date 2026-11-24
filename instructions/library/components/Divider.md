COMPONENT: Divider

A horizontal line across the full width, with 8px of space above and below.

Written as `<Divider />`. It holds nothing.

| Attribute | Values | What it does on screen |
|---|---|---|
| label | text | Shown in the middle on one line, with the line on each side. |
| variant | solid, dashed, dotted | Style of the line. Default solid. |
| color | default, surface, primary, secondary, tertiary (the theme's three colours), success, warning, error (usually green, amber and red, but each theme sets them) | Colour of the line. default is the theme's border colour. |
| size | xs, sm, md, lg, xl | Thickness: 0.5px, 1px, 2px, 3px, 4px. Default sm. |

```component
<Divider label="Details" variant="dashed" />
```
