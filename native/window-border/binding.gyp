{
  "targets": [
    {
      "target_name": "window_border",
      "sources": [ "window_border.c", "window_rect.c" ],
      "conditions": [
        [ "OS=='win'", { "libraries": [ "-lcomctl32", "-luser32" ] } ]
      ]
    }
  ]
}
