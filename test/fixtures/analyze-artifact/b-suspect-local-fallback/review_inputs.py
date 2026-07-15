"""Client-side validation ping that degrades gracefully if the check endpoint is unreachable — the
`/api/check` shape from the plan's MANIFEST (response consulted, no persist claim on failure)."""

CHECK_SNIPPET = """
<script>
  function validateField(name, value) {
    fetch("/api/check", {
      method: "POST",
      body: JSON.stringify({ name: name, value: value }),
    }).then(function (resp) {
      if (resp.ok) {
        markValid(name);
      } else {
        // Non-ok: quietly skip server-side validation, keep the field editable locally.
        markUnvalidated(name);
      }
    });
  }
</script>
"""
