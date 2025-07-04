# OpenSearch/Elasticsearch Stats Gathering Script

This script is designed to connect to your OpenSearch or Elasticsearch cluster and pull a comprehensive set of statistics from various API endpoints. It then compiles all this information into a single, well-structured markdown file. This consolidated file is ideal for performance analysis, troubleshooting, or sharing with support teams.

The script is intentionally designed to be cross-platform compatible, but **requires a `bash` environment to run**. This is available by default on Linux and macOS. For Windows users, it can be run using a `bash` shell provided by **Git Bash** or the **Windows Subsystem for Linux (WSL)**.

### How to Use the Script

1.  **Save the Script:** Copy the code below and save it to a file named `gather_opensearch_stats.sh`.
2.  **Make it Executable (Linux/macOS):** Open your terminal and run the following command to make the script executable:
    ```sh
    chmod +x gather_opensearch_stats.sh
    ```
3.  **Run the Script:** Execute the script from your terminal, providing the name of the primary index you want to analyze. You can also specify the host and port if they are not the default `localhost:9200`.

    **Basic Usage (Linux, macOS, Windows with Git Bash/WSL):**
    ```sh
    ./gather_opensearch_stats.sh <your-index-name>
    ```

    **Example:**
    ```sh
    ./gather_opensearch_stats.sh my_index
    ```

    **Specifying Host and Port:**
    ```sh
    ./gather_opensearch_stats.sh <your-index-name> <host> <port>
    ```

    **Example:**
    ```sh
    ./gather_opensearch_stats.sh my_index opensearch.mycompany.com 9200
    ```
4.  **Find the Output:** The script will create a single markdown file in the current directory, named `my_index_dump_YYYYMMDD_HHMMSS.md`, containing all the gathered statistics.

---

## Script to Download

```sh
#!/usr/bin/env bash
#
# Description:
#   This script gathers a comprehensive set of statistics from an OpenSearch/Elasticsearch
#   cluster and consolidates them into a single markdown file for performance analysis.
#
# Usage:
#   ./gather_opensearch_stats.sh <index-name> [host] [port]
#
# Examples:
#   # Basic usage
#   ./gather_opensearch_stats.sh my_index
#
#   # With custom host and port
#   ./gather_opensearch_stats.sh my_index es.my-domain.com 9201
#
# Compatibility:
#   - Linux: Native
#   - macOS: Native
#   - Windows: Requires a bash shell like Git Bash or Windows Subsystem for Linux (WSL).
#
# Dependencies:
#   - curl: Must be installed and available in the system's PATH.
#

# --- Script Configuration ---
# Exit immediately if a command exits with a non-zero status.
set -euo pipefail

# --- Input Validation ---
if [ $# -lt 1 ]; then
  echo "ERROR: Missing required argument."
  echo "▶️  Usage: $0 <index-name> [host] [port]"
  echo "▶️  Example: bash $0 documents"
  exit 1
fi

# --- Variable Definitions ---
INDEX="$1"
HOST="${2:-localhost}"
PORT="${3:-9200}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
OUTPUT_FILE="${INDEX}_dump_${TIMESTAMP}.md"
BASE_URL="http://${HOST}:${PORT}"

# --- Helper Function for Making Requests ---
# This function calls a URL, adds a descriptive header, and appends the JSON/text output
# to the single output file.
gather_stat() {
  local title="$1"
  local url="$2"
  local is_json="${3:-true}" # Assume JSON output by default

  echo "## $title" >> "$OUTPUT_FILE"
  echo "" >> "$OUTPUT_FILE" # Add a newline for better spacing

  if [ "$is_json" = true ]; then
    echo '```json' >> "$OUTPUT_FILE"
    # Append a newline to the curl output to ensure the closing ``` is on its own line.
    (curl -s "$url"; echo) >> "$OUTPUT_FILE"
    echo '```' >> "$OUTPUT_FILE"
  else
    echo '```text' >> "$OUTPUT_FILE"
    (curl -s "$url"; echo) >> "$OUTPUT_FILE"
    echo '```' >> "$OUTPUT_FILE"
  fi

  echo "" >> "$OUTPUT_FILE"
  echo "---" >> "$OUTPUT_FILE" # Separator for readability
  echo "" >> "$OUTPUT_FILE"
}

# --- Main Execution Logic ---
echo "🔍 Gathering stats for index '$INDEX' from $HOST:$PORT..."
echo "   Output will be written to: $OUTPUT_FILE"

# Create the file and add a main title
echo "# OpenSearch Stats Dump for Index: $INDEX" > "$OUTPUT_FILE"
echo "Generated on: $(date)" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"
echo "---" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"

# 1. Cluster Health
gather_stat "Cluster Health" "${BASE_URL}/_cluster/health?pretty"

# 2. Cluster Stats (Aggregated)
gather_stat "Cluster Stats" "${BASE_URL}/_cluster/stats?pretty"

# 3. Nodes Stats
gather_stat "Nodes Stats" "${BASE_URL}/_nodes/stats?pretty"

# 4. Index-specific Stats
gather_stat "Index Stats (${INDEX})" "${BASE_URL}/${INDEX}/_stats?pretty"

# 5. Index-specific Settings (including defaults)
gather_stat "Index Settings (${INDEX})" "${BASE_URL}/${INDEX}/_settings?pretty&include_defaults=true"

# 6. Index Segments
gather_stat "Index Segments (${INDEX})" "${BASE_URL}/${INDEX}/_segments?pretty"

# 7. k-NN Plugin Stats (if installed)
gather_stat "k-NN Plugin Stats" "${BASE_URL}/_plugins/_knn/stats?pretty"

# 8. Pending Cluster Tasks
gather_stat "Pending Cluster Tasks" "${BASE_URL}/_cluster/pending_tasks?pretty"

# 9. Nodes Hot Threads (diagnosing CPU usage)
gather_stat "Nodes Hot Threads" "${BASE_URL}/_nodes/hot_threads?threads=10" false

# 10. Cat APIs (Plain-text, human-readable summaries)
gather_stat "CAT: Nodes" "${BASE_URL}/_cat/nodes?v&s=cpu:desc" false
gather_stat "CAT: Indices" "${BASE_URL}/_cat/indices?v&s=index" false
gather_stat "CAT: Shards" "${BASE_URL}/_cat/shards?v&s=index" false
gather_stat "CAT: Segments (${INDEX})" "${BASE_URL}/_cat/segments/${INDEX}?v" false
gather_stat "CAT: Allocation" "${BASE_URL}/_cat/allocation?v&bytes=gb" false
gather_stat "CAT: Thread Pool (Search)" "${BASE_URL}/_cat/thread_pool/search?v&h=node_name,name,active,queue,rejected" false
gather_stat "CAT: Thread Pool (Write)" "${BASE_URL}/_cat/thread_pool/write?v&h=node_name,name,active,queue,rejected" false
gather_stat "CAT: Tasks" "${BASE_URL}/_cat/tasks?v&detailed" false
gather_stat "CAT: Plugins" "${BASE_URL}/_cat/plugins?v" false


echo "✅ Done. All stats have been written to: $OUTPUT_FILE"

```