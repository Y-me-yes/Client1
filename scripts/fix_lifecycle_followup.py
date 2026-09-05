from pathlib import Path

p = Path('server/server.py')
s = p.read_text(encoding='utf-8')
old = '''                            "expiresAt": None,\n                            "archivedAt": now_ms,\n                            "archiveReason": "manual",\n                        }'''
new = '''                            "expiresAt": None,\n                            "archivedAt": now_ms,\n                            "archiveReason": "manual",\n                            "viewedBy": list(m.get("viewedBy") or []),\n                            "returnType": None,\n                        }'''
if s.count(old) != 1:
    raise SystemExit(f'message archive row target: expected 1 match, found {s.count(old)}')
s = s.replace(old, new, 1)
p.write_text(s, encoding='utf-8')
