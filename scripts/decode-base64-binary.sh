#!/bin/bash

# decode-base64-binary.sh
# Helper script to decode base64 encoded iHub Apps binaries
# Usage: ./decode-base64-binary.sh <base64-file.txt>

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}📦 iHub Apps Base64 Binary Decoder${NC}"
echo -e "${BLUE}====================================${NC}"
echo ""

# Check if base64 file is provided
if [ $# -eq 0 ]; then
    echo -e "${RED}❌ Error: No base64 file specified${NC}"
    echo ""
    echo -e "${YELLOW}Usage:${NC}"
    echo "  $0 <base64-file.txt>"
    echo ""
    echo -e "${YELLOW}Examples:${NC}"
    echo "  $0 ihub-apps-v3.3.0-linux.tar.gz.base64.txt"
    echo "  $0 ihub-apps-v3.3.0-win.zip.base64.txt"
    echo ""
    echo -e "${YELLOW}Available base64 files:${NC}"
    ls -1 *.base64.txt 2>/dev/null || echo "  No base64 files found in current directory"
    exit 1
fi

BASE64_FILE="$1"

# Check if base64 file exists
if [ ! -f "$BASE64_FILE" ]; then
    echo -e "${RED}❌ Error: File '$BASE64_FILE' not found${NC}"
    exit 1
fi

# Determine output filename by removing .base64.txt extension
OUTPUT_FILE=$(echo "$BASE64_FILE" | sed 's/\.base64\.txt$//')

if [ "$OUTPUT_FILE" == "$BASE64_FILE" ]; then
    echo -e "${RED}❌ Error: File '$BASE64_FILE' does not appear to be a base64 encoded file${NC}"
    echo -e "${YELLOW}💡 Base64 files should end with .base64.txt${NC}"
    exit 1
fi

echo -e "${BLUE}📁 Input file:${NC} $BASE64_FILE"
echo -e "${BLUE}📁 Output file:${NC} $OUTPUT_FILE"
echo ""

# Check if output file already exists
if [ -f "$OUTPUT_FILE" ]; then
    echo -e "${YELLOW}⚠️  Warning: Output file '$OUTPUT_FILE' already exists${NC}"
    read -p "Do you want to overwrite it? (y/N): " -r
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}🚫 Operation cancelled${NC}"
        exit 0
    fi
fi

# Decode the base64 file
echo -e "${BLUE}🔄 Decoding base64 file...${NC}"
if base64 -d "$BASE64_FILE" > "$OUTPUT_FILE"; then
    echo -e "${GREEN}✅ Successfully decoded to: $OUTPUT_FILE${NC}"
    
    # Show file sizes
    BASE64_SIZE=$(wc -c < "$BASE64_FILE")
    OUTPUT_SIZE=$(wc -c < "$OUTPUT_FILE")
    
    echo ""
    echo -e "${BLUE}📊 File Information:${NC}"
    echo -e "  Base64 file size: ${YELLOW}$(numfmt --to=iec $BASE64_SIZE)${NC}"
    echo -e "  Decoded file size: ${YELLOW}$(numfmt --to=iec $OUTPUT_SIZE)${NC}"
    
    # Provide next steps based on file extension
    echo ""
    echo -e "${BLUE}🚀 Next Steps:${NC}"
    if [[ "$OUTPUT_FILE" == *.tar.gz ]]; then
        echo -e "  Extract the archive: ${YELLOW}tar -xzf '$OUTPUT_FILE'${NC}"
        echo -e "  Then run the binary from the extracted directory"
    elif [[ "$OUTPUT_FILE" == *.zip ]]; then
        echo -e "  Extract the archive: ${YELLOW}unzip '$OUTPUT_FILE'${NC}"
        echo -e "  Then run the .bat file from the extracted directory"
    else
        echo -e "  Make executable: ${YELLOW}chmod +x '$OUTPUT_FILE'${NC}"
        echo -e "  Run the binary: ${YELLOW}./'$OUTPUT_FILE'${NC}"
    fi
    
else
    echo -e "${RED}❌ Error: Failed to decode base64 file${NC}"
    echo -e "${RED}   Please check that the file is a valid base64 encoded file${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}🎉 Decoding completed successfully!${NC}"