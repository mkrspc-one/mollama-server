COMPONENT: Input

A text field the user can type in. What is typed stays in the field: it is not sent anywhere and you never see it.

Written as `<Input label="..." />`. It holds nothing. It is as wide as the box it is in.

| Attribute | Values | What it does on screen |
|---|---|---|
| label | text | Shown above the field. |
| placeholder | text | Shown inside the field while it is empty. |
| multiline | no value | A taller field for several lines, which the user can drag taller. |
| rows | a number | How many lines tall a multiline field starts. Default 3. |

```component
<Input label="Your name" placeholder="First and last" />
```
