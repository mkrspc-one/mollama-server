COMPONENT: FloatingActionButton

A round button that floats over a corner or an edge of the Card it is in, 16px from the edge. It takes no space of its own, so it covers whatever is under it: leave room in the Card, for example with minHeight="160px". It must be written directly inside a Card.

Written as `<FloatingActionButton icon="FiPlus" send="..." />`. It holds nothing.

| Attribute | Values | What it does on screen |
|---|---|---|
| icon | an icon name (see Icon) | Required. The drawing on the button. |
| send | text | The message sent in the chat on a click. Without it a click does nothing. |
| position | top-left, top, top-right, left, right, bottom-left, bottom, bottom-right | Which corner or edge it sits on. Default bottom-right. |
| color | primary, secondary, tertiary (the theme's three colours), success, warning, error (usually green, amber and red, but each theme sets them) | Colour of the icon and thin border; the button fills with it on hover. Default primary. |
| size | xs, sm, md, lg, xl | Diameter: 32, 40, 56, 72 or 88px. Default md. |
| badge | short text or a number | A tiny label on the top right of the button, at most 10 characters. |
| badgeColor | primary, secondary, tertiary (the theme's three colours), success, warning, error (usually green, amber and red, but each theme sets them) | Colour of that label. Default error. |
| draggable | no value | The user can drag the button around the Card; when let go near an edge it snaps to it. |

```component
<Card minHeight="160px" width="100%">
  <Typography weight="bold">Notes</Typography>
  <FloatingActionButton icon="FiPlus" position="bottom-right" send="Add a note" />
</Card>
```
