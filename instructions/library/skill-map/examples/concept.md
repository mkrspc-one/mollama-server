EXAMPLE: HOW A CONCEPT WORKS

The request
"How does HTTPS keep my connection private? Explain it properly, I want to understand it."

The plan
The idea has three steps that build on each other, so each step gets its own diagram, and a page ties them together:
1. One paragraph: what HTTPS protects and from whom.
2. Flow: the handshake, step by step.
3. A table: the three jobs (privacy, integrity, identity) and what does each.
4. Flow: how the certificate chain proves who the server is.
5. Visual Explainer page: the whole journey of one request, for the user to explore. Only when Visual Explainer is on and visual_explainer_render is offered; otherwise the two diagrams and the table are the answer.
6. A short summary list.

The calls, in order
1. open_component Flow (read once, used for both diagrams).
2. open_skill Visual Explainer, then the reference its page names for diagrams.
3. visual_explainer_render with the whole page. Fix every problem it reports and call it again.

The reply

When you visit a site over HTTPS, three things are protected: nobody on the way can read what you send (privacy), nobody can change it without being noticed (integrity), and you know you are talking to the real site (identity). All three are set up in the first fraction of a second, in a conversation called the handshake.

**The handshake**

```component
<Flow height="400px" arrange="tb">
  <Node id="hello" label="**1. Hello**&#10;Your browser lists the ciphers it knows and sends a random number" color="primary" />
  <Node id="cert" label="**2. Certificate**&#10;The server picks a cipher and sends its certificate and key share" color="secondary" />
  <Node id="check" label="**3. Check**&#10;Your browser checks the certificate against the authorities it trusts" color="warning" shape="diamond" />
  <Node id="keys" label="**4. Shared key**&#10;Both sides combine their key shares into the same secret, never sent" color="success" />
  <Node id="data" label="**5. Private traffic**&#10;Everything after is encrypted with that key" color="tertiary" />
  <Edge source="hello" target="cert" />
  <Edge source="cert" target="check" />
  <Edge source="check" target="keys" label="trusted" color="success" />
  <Edge source="keys" target="data" animated="true" />
</Flow>
```

The clever part is step 4: each side sends half of a puzzle, and both can work out the same secret from the two halves, but someone who saw both halves cannot.

| Job | What does it | What it stops |
|---|---|---|
| Privacy | The shared key encrypts every message | Someone on the café Wi-Fi reading your password |
| Integrity | Each message carries a code made with the key | Someone changing a bank account number on the way |
| Identity | The certificate, signed by a trusted authority | A fake site pretending to be your bank |

**Why you can trust the certificate**

```component
<Flow height="320px" arrange="lr">
  <Node id="root" label="**Root authority**&#10;built into your browser" color="success" shape="cylinder" />
  <Node id="mid" label="**Intermediate**&#10;signed by the root" color="secondary" />
  <Node id="site" label="**example.com**&#10;signed by the intermediate" color="primary" />
  <Edge source="root" target="mid" label="signs" />
  <Edge source="mid" target="site" label="signs" />
</Flow>
```

Your browser trusts a few hundred root authorities. The site's certificate is trusted because a chain of signatures leads back to one of them.

**The whole journey**

[The Visual Explainer page appears here, shown by visual_explainer_render.]

In short
- The handshake agrees a secret that is never sent.
- That secret hides and seals every message.
- The certificate chain proves the site is who it says.

What made this answer work
- One diagram per step of the idea, each with a sentence on what it shows.
- The page was an extra for exploring, not a replacement for the explanation.
