Q="--quickchr ${M:-appset-wipe-7251}"; P=pcie1/apps/wipeprobe/probe-data
echo "seed: $(centrs execute $Q ":put [/file/get \"$P/seed\" contents]" 2>&1 | grep -o '"ret": .*')"
echo "boots: $(centrs execute $Q ":put [/file/get \"$P/boots\" contents]" 2>&1 | grep -o '"ret": .*')"
centrs execute $Q '/container/print' 2>&1 | grep -E '"(running|env|root-dir)"' | tr -d '\n'; echo
