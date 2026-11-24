COMPONENT: PdfViewer

A reader for a PDF file, as wide as the reply and 70% of the window tall. It shows one page at a time, fitted to the reader's height.

Written as `<PdfViewer src="https://..." />`. It holds nothing.

| Attribute | Values | What it does on screen |
|---|---|---|
| src | the https address of a PDF file | Required. The file that is shown. |

The user can move between pages with the arrows at the bottom (or the arrow keys), where it reads "Page 1 of 12"; zoom with Ctrl and the scroll wheel, or from the small tools button (zoom in, zoom out, fit to screen, 100%); and select and copy the text. There is no search, download or print button, and nothing can be changed.

The file is fetched for the user by Mollama: it must be a public https address, at most 50 MB. While it loads the user sees "Loading the file from the web…". If it cannot be shown they see a short reason instead, such as "Nothing exists at this address…", "This address is a web page, not a file…" or "This file is larger than 50 MB…". A "Source:" link to the address is shown underneath. A file that is not a readable PDF shows "Failed to load PDF".
