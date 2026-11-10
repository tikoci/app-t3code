:local app "wipeprobe"; :local key "probe:TOOL_GROUPS="; :local val "vpn"
:local keep ({}); :foreach e in=[/app/get $app environment] do={ :if ([:find $e $key] != 0) do={ :set keep ($keep, $e) } }
/app/set $app environment=($keep, ($key . $val))
