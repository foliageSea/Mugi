# One bounded snapshot, shared by system ADB and WebUSB. Missing files stay empty.
echo __UPTIME__
cat /proc/uptime 2>/dev/null
echo __CPU__
head -n 1 /proc/stat 2>/dev/null
echo __MEMORY__
cat /proc/meminfo 2>/dev/null
echo __NETWORK__
if ! cat /proc/net/dev 2>/dev/null; then
  for interface in /sys/class/net/*; do
    rx=$(cat "$interface/statistics/rx_bytes" 2>/dev/null) || continue
    tx=$(cat "$interface/statistics/tx_bytes" 2>/dev/null) || continue
    echo "${interface##*/}: $rx 0 0 0 0 0 0 0 $tx 0 0 0 0 0 0 0"
  done
fi
echo __END__
