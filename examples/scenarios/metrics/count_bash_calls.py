"""A command metric: how many Bash calls the agent made in this turn.

Run by cowork-harness as `python3 count_bash_calls.py <events-file>` (through its runner). The events file is the
turn's slice of the run's events.jsonl, one JSON object per line. Prints exactly one number.

The author contract: print a number for every events file that parses ("no Bash calls" is 0); exit nonzero only
for input that cannot be measured; treat every string in the transcript as hostile (never eval, exec or shell out
on it). Standard library only.
"""

import json
import sys


def main():
    count = 0
    with open(sys.argv[1], encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict) or event.get("type") != "assistant":
                continue
            content = (event.get("message") or {}).get("content") or []
            for block in content if isinstance(content, list) else []:
                if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name") == "Bash":
                    count += 1
    print(count)


if __name__ == "__main__":
    main()
