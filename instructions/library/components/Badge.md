COMPONENT: Badge

A small pill with a word or two, tinted with its colour, the text in a darker shade of that colour that reads on the tint. It stays on one line.

Written as `<Badge>text</Badge>`.

| Attribute | Values | What it does on screen |
|---|---|---|
| color | default, primary, secondary, tertiary (the theme's three colours), success, warning, error (usually green, amber and red, but each theme sets them) | The colour of the tint and the text. default is a neutral tint. |
| size | xxs, xs, sm, md, lg, xl | Text height 12, 13, 13, 14, 15 or 16px. Default sm. |

```component
<Badge color="warning">Pending</Badge>
```
