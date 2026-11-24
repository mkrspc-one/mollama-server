COMPONENT: Sheet

A viewer for a spreadsheet file, as wide as the reply: a grid with column letters across the top and row numbers down the side, as in a spreadsheet program, with the file's name at the top left.

Written as `<Sheet src="https://..." />`. It holds nothing.

| Attribute | Values | What it does on screen |
|---|---|---|
| src | the https address of an .xlsx or .csv file | Required. The file that is shown. |
| height | a CSS length with its unit, such as 420px or 60vh | How tall the viewer is. Default 420px. The grid scrolls inside it, and the letters and numbers stay in view. |

What the grid shows: each sheet of the file is a button at the bottom left, and the first one is open. Merged cells are drawn as one cell and bold text is bold. Numbers are right-aligned with the decimals or percent sign the file gives them, dates read as 2026-11-19, and true and false read TRUE and FALSE. The file's fonts, colours, column widths, borders, charts and pictures are not shown.

Formulas: a cell with a formula shows the result stored in the file. Nothing is worked out again here. A formula the file holds no result for is shown as written, in italics, and a line under the grid says how many there are.

The user can click a cell to see its address and what it holds in the bar above the grid; for a formula that reads "=SUM(B3:B5) → 2,200.50". When the file has formulas a "Show formulas" switch under the grid shows every formula in place of its result. Row 1 is taken as the headings: it stays at the top of every page and names the columns in the controls. Above the grid the user has a box that searches every column, a "Filters" button that opens one filter per column, and a "Columns" button that hides or shows columns. Under the grid they choose how many rows a page holds (10, 20, 50, 100 or 500; 100 at first), sort by any column upwards or downwards, and move between pages. While rows are searched, filtered or sorted a line says how many match, and each row keeps its own number. Every row and column of the file is read. Nothing in the file can be changed.

The file is fetched for the user by Mollama: it must be a public https address, at most 50 MB. While it loads the user sees "Loading the file from the web…". If it cannot be shown they see a short reason instead, such as "Nothing exists at this address…", "This address is a web page, not a file…" or "This file is larger than 50 MB…". A "Source:" link to the address is shown underneath. A file that is not a readable spreadsheet shows "This file could not be shown as a sheet."
