@rem Claude Code hook: tells the deck bridge what a session just did, so the
@rem tablet knows the moment a turn ends or a permission prompt appears.
@rem Installed by `npm run hooks`. It must never slow Claude down or show an
@rem error. Windows retries a refused local connection for about 2 s, so the
@rem connect wait is capped at 0.2 s (the bridge answers in about 1 ms), the
@rem whole call at 1 s, and the script always exits 0. 4771 is the bridge's
@rem default port; change it here too if you change "port" in deck.config.jsonc.
@curl.exe -s --connect-timeout 0.2 -m 1 -o NUL -H "content-type: application/json" --data-binary @- http://127.0.0.1:4771/deck/hook
@exit /b 0
