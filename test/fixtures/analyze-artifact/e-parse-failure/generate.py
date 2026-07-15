"""Generator whose template still holds an unresolved Python-side placeholder inside what would
otherwise be a <script> block — this produces genuinely invalid JS when isolated by the extractor
(the `${ENDPOINT}` here is a bare dollar-brace with no enclosing backtick template literal, which is a
JS syntax error, not a valid expression)."""

TEMPLATE = """
<html>
<body>
  <script>
    document.title = "feedback";
    fetch("/api/" + ${ENDPOINT}, { method: "POST" });
  </script>
</body>
</html>
"""
