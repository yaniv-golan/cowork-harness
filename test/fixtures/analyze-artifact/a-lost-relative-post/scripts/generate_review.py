"""Generates the interactive eval-viewer HTML artifact (mirrors the skill-creator-plus archetype:
the write-back string lives in a Python template, not committed .html)."""

VIEWER_HTML = """
<!DOCTYPE html>
<html>
<head><title>Eval Viewer</title></head>
<body>
  <button id="submit">Submit feedback</button>
  <script>
    document.getElementById("submit").addEventListener("click", function () {
      fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: 5 }),
      }).then(function () {
        document.getElementById("submit").textContent = "Saved!";
      });
    });
  </script>
</body>
</html>
"""


def write_viewer(path):
    with open(path, "w") as f:
        f.write(VIEWER_HTML)
