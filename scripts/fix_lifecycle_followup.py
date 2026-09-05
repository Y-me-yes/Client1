from pathlib import Path

server = Path('server/server.py')
s = server.read_text(encoding='utf-8')
old = '''                            "expiresAt": None,\n                            "archivedAt": now_ms,\n                            "archiveReason": "manual",\n                        }'''
new = '''                            "expiresAt": None,\n                            "archivedAt": now_ms,\n                            "archiveReason": "manual",\n                            "viewedBy": list(m.get("viewedBy") or []),\n                            "returnType": None,\n                        }'''
if s.count(old) != 1:
    raise SystemExit(f'message archive row target: expected 1 match, found {s.count(old)}')
s = s.replace(old, new, 1)
old_doc = '''        active-list row without an extra round-trip."""\n        if not isinstance(m, dict):'''
new_doc = '''        active-list row without an extra round-trip. View state is\n        tracked per student so viewed content can be saved to that\n        student's personal archive when they leave."""\n        if s.count(old_doc) == 1:
    s = s.replace(old_doc, new_doc, 1)
server.write_text(s, encoding='utf-8')
