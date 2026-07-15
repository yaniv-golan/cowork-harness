"""Fixture generator (skill A) with a lost relative write-back."""

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
