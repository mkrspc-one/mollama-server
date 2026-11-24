COMPONENT: Image

A picture, shown at its own size and never wider than the reply. It comes from an address, or you draw it yourself as SVG. The user cannot click, zoom or download it.

Written as `<Image src="https://..." alt="..." />` for a picture file, or as `<Image> ... </Image>` with your own `<svg>...</svg>` between the tags and nothing before it.

| Attribute | Values | What it does on screen |
|---|---|---|
| src | the https address of a picture | The picture shown: any kind the browser can show, such as png, jpg, gif or webp. |
| alt | text | A description for screen readers. It is not shown as a caption. |
| width, height | a CSS length with its unit, such as 100% or 240px | The box the picture is fitted into. The picture keeps its shape: it is never stretched, so giving both can leave empty space beside it. An SVG of your own with only a viewBox has no size of its own, so give it a width. |

The file is fetched for the user by Mollama: it must be a public https address, at most 50 MB. While it loads the user sees "Loading the file from the web…". If it cannot be shown they see a short reason instead, such as "Nothing exists at this address…", "This address is a web page, not a file…" or "This file is larger than 50 MB…". A "Source:" link to the address is shown underneath. A picture that cannot be read shows "Failed to load image".

```component
<Image alt="A red circle" width="120px">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="crimson" /></svg>
</Image>
```
