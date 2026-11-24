COMPONENT: Switch

An on and off toggle: a small track with a round knob. The user can flip it by clicking the track or its label; the knob slides across and the track takes the primary colour when on. Flipping it changes only how it looks: nothing is sent and you never see it.

Written as `<Switch label="..." />`. It holds nothing.

| Attribute | Values | What it does on screen |
|---|---|---|
| label | text | Shown to the right of the toggle. |
| defaultChecked | no value | The toggle starts switched on. |

```component
<Switch label="Email me a copy" defaultChecked />
```
