COMPONENT: Data

A table of records with its own controls: a search box, filters, a list of columns to show or hide, a switch between table, cards and list, sorting, and pages of 10 rows.

Written as `<Data> ... </Data>` with one Row for each record, or as `<Data src="https://..." />` to show a CSV or JSON file.

| Attribute | Values | What it does on screen |
|---|---|---|
| variant | table, cards, list | The view it opens in; the user can switch. **table** (default): rows and columns with a shaded header. **cards**: one small panel for each record with "Field: value" lines, as many per row as fit. **list**: one full-width panel for each record, its fields side by side. |
| src | the https address of a CSV or JSON file | Shows that file instead of Rows. CSV: commas, first line is the header. JSON: a list of objects, or an object holding one. Only the first 500 rows are kept. |

Tags inside Data:

| Tag | Attributes | What it does on screen |
|---|---|---|
| `<Row />` | any names, such as task="Design" dueDate="Friday" | One record; each attribute is a column. Names have no spaces. **The column heading comes from the name**: its first letter is capitalised and a space goes before each later capital, so dueDate reads "Due Date" and task reads "Task". Columns appear in the order of the first Row. A value that is a number is shown as a number (1,200 becomes 1200). An address is shown as plain text, not a link. Missing values are left blank. |
| `<Column />` | key, as, colors, label | Optional. Changes how one column is drawn. **key**: the Row attribute it applies to. **as="Badge"**: each value in a small filled label. **as="ProgressBar"**: a number from 0 to 100 as a bar, coloured by how full it is, with no number beside it. **as="Typography"**: plain text that can be coloured. **colors**: which value gets which colour, as pairs such as "Open:success, Late:error"; the value must match exactly, capitals included. **label**: a name for the column in the show-or-hide list only; it does not change the heading. |

What the user can do: type in "Search all columns…"; open Filters for one control per column (a date range, a dropdown when there are 10 or fewer different values, otherwise a text box); show or hide columns; switch view; sort by any column from a dropdown under the table; choose 5, 10, 20, 50 or 100 rows per page. Only 10 rows show at first, so the rest are on later pages. A wide table scrolls sideways; long text is not cut.

```component
<Data>
  <Column key="status" as="Badge" colors="Open:success, Late:error" />
  <Column key="done" as="ProgressBar" />
  <Row task="Design" status="Open" done="40" />
  <Row task="Build" status="Late" done="10" />
</Data>
```
A table headed Task, Status and Done: the status as a green or red label, done as a bar.

With no Row and no src nothing is drawn. If a file cannot be read as a table the user sees "This file does not hold a table that can be shown. Use a CSV file or a JSON list."
