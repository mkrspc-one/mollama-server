COMPONENT: Icon

A small drawing.

Written as `<Icon name="FiCheck" />`. It holds nothing.

| Attribute | Values | What it does on screen |
|---|---|---|
| name | an icon name | Required. Any name from these react-icons sets works: Feather (Fi…, thin line drawings, such as FiCheck, FiX, FiAlertTriangle, FiInfo, FiStar, FiUser, FiClock, FiCalendar, FiFolder, FiFile, FiHome, FiSettings, FiTrendingUp, FiMail, FiMapPin, FiHeart), Material (Md…), Heroicons (Hi…), Font Awesome (Fa…), Grommet (Gr…) and Tabler (Tb…). A name that does not exist draws a question mark in a circle. |
| color | text, contrast, primary, secondary, tertiary (the theme's three colours), success, warning, error (usually green, amber and red, but each theme sets them) | Colour of the drawing. Default primary. text is the normal text colour. |
| size | xs, sm, md, lg, xl, 2xl | Width and height: 18, 24, 32, 42, 52 or 64px on a desktop-width window. Default sm. |

```component
<Icon name="FiAlertTriangle" color="warning" size="md" />
```
