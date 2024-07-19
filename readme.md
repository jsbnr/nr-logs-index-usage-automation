# Auto Logs Index Threshold Reporter

This script reports the usage of and index against a threshold defined in a lookup table. 
It automatically adds new indexes to the lookup table if they are not found.
For each index the usage is recorded in two metrics `LogIndexUsagePercent` and `LogIndexUsage`. The values of these can be used to trigger alerts.
