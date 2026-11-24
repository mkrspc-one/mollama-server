COMPONENT: Slides

A viewer for a PowerPoint file, as wide as the reply. It shows one slide at a time, fitted to the viewer's width, with the file's name at the top left.

Written as `<Slides src="https://..." />`. It holds nothing.

| Attribute | Values | What it does on screen |
|---|---|---|
| src | the https address of a .pptx file | Required. The file that is shown. |
| height | a CSS length with its unit, such as 60vh or 480px | How tall the viewer is. Default 60vh. A slide taller than that scrolls inside the viewer. |

The user can move between slides with the two arrow buttons at the top right, where it reads "Slide 1 of 12", or with the arrow keys once the viewer has been clicked. Text on a slide can be selected and copied. There is no zoom, search, download or full-screen button, and nothing can be changed.

The slides are drawn in the browser from the file itself, so they look close to PowerPoint but not identical. Animations, transitions, speaker notes, 3D effects and embedded objects are not shown, and a font the user's computer does not have is replaced by another.

The file is fetched for the user by Mollama: it must be a public https address, at most 50 MB. While it loads the user sees "Loading the file from the web…". If it cannot be shown they see a short reason instead, such as "Nothing exists at this address…", "This address is a web page, not a file…" or "This file is larger than 50 MB…". A "Source:" link to the address is shown underneath. A file that is not a readable .pptx shows "This file could not be shown as slides."
