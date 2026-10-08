# Desktop form replies

Two replies in the shape Desktop's elicitation form sends as the next user message, for testing a skill that parses
one. Each is modelled on a real Cowork reply (which fields are a date, a multi-select, a quoted value, a ` / `-flattened
value or a folded one, and how many lines a folded value spans), with every title, label and value replaced, and its
fields in the order Desktop's form collects them. `test/desktop-form-reply.test.ts` pins both to Desktop's reply
format, byte for byte. Both end without a trailing newline, as a real reply does.

| File | Covers |
|---|---|
| `pitch-review.txt` | a multi-select (comma-joined), a date, a short value, and two values over 200 characters folded under `--- Full content ---`, one of them spanning several lines |
| `deck-review.txt` | a pill value, a quoted 81–200 character value, two folded values, and a quoted value whose blank-line paragraphs flatten to `  /  / ` |

Send one as a resumed turn, from the file so the shell cannot expand a `$` in it:
`cowork-harness skill ./my-plugin --prompt-file examples/data/form-replies/pitch-review.txt --session-id s --resume`.
