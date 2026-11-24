COMPONENT: ProgressBar

A horizontal bar, as wide as the box it is in, filled to a share of its length. The fill slides to its place when it appears.

Written as `<ProgressBar value="60" />`. It holds nothing.

| Attribute | Values | What it does on screen |
|---|---|---|
| value | a number | Required. How much is filled, counted against max. Kept between 0 and max. |
| max | a number | The value at which the bar is full. Default 100. |
| label | text | Shown on a line above the bar, at the left. |
| showPercentage | no value | Shows the filled share as "72%" on the line above the bar, at the right. |
| color | default, primary, secondary, tertiary (the theme's three colours), success, warning, error (usually green, amber and red, but each theme sets them) | Colour of the filled part. Without it the bar colours itself by how full it is: error below 33%, warning below 66%, tertiary below 85%, success above. |
| size | xs, sm, md, lg, xl | Thickness: 6, 8, 11, 15 or 20px on a desktop-width window. Default md. |
| striped | no value | Diagonal stripes on the filled part. |
| animated | no value | Makes the stripes move. Needs striped. |

```component
<ProgressBar value="3" max="8" label="Steps done" showPercentage color="success" />
```
