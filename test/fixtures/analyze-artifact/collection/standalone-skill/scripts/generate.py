"""Fixture generator with a lost relative write-back — used only to prove `scripts/` is reached by
source collection, not to re-test outcome classification (see the a-lost-relative-post fixture)."""

VIEWER_HTML = """
<html>
<body>
  <script>
    fetch("/api/feedback", { method: "POST", body: JSON.stringify({ ok: true }) }).then(function () {
      document.title = "Saved!";
    });
  </script>
</body>
</html>
"""
