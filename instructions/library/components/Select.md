COMPONENT: Select

A dropdown. Closed, it is a field showing the chosen entry or the placeholder, with an arrow at the right. Clicking it opens a list under the field, up to 200px tall. With the list open the user can type to narrow it down, move with the arrow keys and pick with Enter. The pick stays in the field: it is not sent anywhere and you never see it.

Written as `<Select label="..."> ... </Select>` with Option tags between.

| Attribute | Values | What it does on screen |
|---|---|---|
| label | text | Shown above the field. |
| placeholder | text | Shown in the field before anything is picked. Without it the field reads "Search options...". |

| Tag | Attributes | What it does on screen |
|---|---|---|
| `<Option />` | label, value | One entry. label is the text shown. value is a short name for it; without one the label is used. |

```component
<Select label="Size" placeholder="Pick one">
  <Option value="s" label="Small" />
  <Option value="l" label="Large" />
</Select>
```
