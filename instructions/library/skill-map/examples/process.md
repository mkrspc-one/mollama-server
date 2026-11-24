EXAMPLE: A PROCESS

The request
"How does a bill become law in the UK?"

The plan
A process is steps in order, with places where it can turn back. One diagram for the path, one tree for who does what, a list for the words.
1. One paragraph: the short version.
2. Flow: the path from first reading to Royal Assent, with the turn back between the Houses.
3. TreeView: the two Houses and the stages in each.
4. A list of the terms used.

The calls, in order
1. open_component Flow, then open_component TreeView.

The reply

A bill is a proposed law. It goes through the same stages in the House of Commons and the House of Lords, the two Houses must agree on every word, and then the monarch signs it.

```component
<Flow height="440px" arrange="lr">
  <Group id="commons" label="House of Commons" color="success" />
  <Group id="lords" label="House of Lords" color="error" />
  <Node id="c1" label="First and second reading" group="commons" color="surface" />
  <Node id="c2" label="Committee and report" group="commons" color="surface" />
  <Node id="c3" label="Third reading" group="commons" color="surface" />
  <Node id="l1" label="First and second reading" group="lords" color="surface" />
  <Node id="l2" label="Committee and report" group="lords" color="surface" />
  <Node id="l3" label="Third reading" group="lords" color="surface" />
  <Node id="pingpong" label="**Agree every word?**" shape="diamond" color="warning" />
  <Node id="assent" label="**Royal Assent**&#10;it becomes an Act" color="primary" />
  <Edge source="c1" target="c2" />
  <Edge source="c2" target="c3" />
  <Edge source="c3" target="l1" />
  <Edge source="l1" target="l2" />
  <Edge source="l2" target="l3" />
  <Edge source="l3" target="pingpong" />
  <Edge source="pingpong" target="assent" label="yes" color="success" />
  <Edge source="pingpong" target="c3" label="amendments go back" color="warning" dashed="true" />
</Flow>
```

The dashed line is "ping-pong": changes go back and forth between the Houses until both accept the same text.

```component
<TreeView>
  <Item label="House of Commons">
    <Item label="First reading: the title is read out" />
    <Item label="Second reading: the main debate" />
    <Item label="Committee: line-by-line changes" />
    <Item label="Report: the whole House reviews the changes" />
    <Item label="Third reading: a final vote" />
  </Item>
  <Item label="House of Lords">
    <Item label="The same five stages" />
  </Item>
  <Item label="Royal Assent" />
</TreeView>
```

Terms
- **Bill**: a law that has not been passed yet.
- **Amendment**: a change proposed to its words.
- **Act**: a bill after Royal Assent.

What made this answer work
- The diagram shows the order and the loop; the tree shows what happens inside each House.
