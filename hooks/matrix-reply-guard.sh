  #!/usr/bin/env bash
  # Stop hook: block turn-end if a Matrix message arrived this turn and was not
  # answered via mcp__matrix__reply. The CLI transcript never reaches the Matrix
  # user, so a transcript-only reply is a silent drop.
  input="$(cat)"
  command -v jq >/dev/null 2>&1 || exit 0
  # Avoid infinite loops: don't re-block during a rewake we ourselves triggered.
  [ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)" = "true" ] && exit 0
  transcript="$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)"

  verdict="$(jq -rs '
    def is_user_prompt: .type=="user" and ((.message.content|type)=="string");
    def is_channel:     is_user_prompt and (.message.content | test("<channel source=\"matrix\""));
    def is_reply:       .type=="assistant" and ((.message.content|type)=="array")
                          and (.message.content | any(.type=="tool_use" and .name=="mcp__matrix__reply"));
    . as $a | ($a|length) as $n
    | ([range(0;$n) | select($a[.]|is_user_prompt)] | last) as $u
    | if   $u==null                                            then "ok"
      elif ($a[$u]|is_channel|not)                             then "ok"
      elif ([range($u;$n) | select($a[.]|is_reply)]|length)>0  then "ok"
      else "block" end
  ' "$transcript" 2>/dev/null || echo ok)"

  [ "$verdict" = "block" ] && jq -n '{
    decision: "block",
    reason: "A Matrix message arrived this turn and you have not called mcp__matrix__reply. The CLI transcript never reaches the user — deliver your full answer through mcp__matrix__reply now (pass room_id, and
  reply_to the inbound event_id). Do not end the turn until you have."
  }'
  exit 0
