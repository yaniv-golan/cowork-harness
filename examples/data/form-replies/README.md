# Desktop form replies

Two replies in the shape Desktop's elicitation form sends as the next user message, for testing a skill that parses
one. Each is modelled on a real Cowork reply (its fields in order, which of them are a date, a multi-select, a quoted
value, a ` / `-flattened value or a folded one, and how many lines a folded value spans), with every title, label and
value replaced. `test/desktop-form-reply.test.ts` pins both to Desktop's serializer, byte for byte.

| File | Covers |
|---|---|
| `pitch-review.txt` | a date, a multi-select (comma-joined), a short value, and two values over 200 characters folded under `--- Full content ---`, one of them spanning several lines |
| `deck-review.txt` | a pill value, a quoted 81–200 character value, two folded values, and a quoted value whose blank-line paragraphs flatten to `  /  / ` |

Send one as a resumed turn: `cowork-harness skill ./my-plugin "$(cat examples/data/form-replies/pitch-review.txt)" --session-id s --resume`.
