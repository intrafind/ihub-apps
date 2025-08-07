// Initialize Mermaid for mdBook
mermaid.initialize({
    startOnLoad: true,
    theme: 'default',
    themeVariables: {
        // Fix styling issues
        primaryColor: '#ffffff',
        primaryTextColor: '#000000',
        primaryBorderColor: '#cccccc',
        lineColor: '#666666',
        secondaryColor: '#f9f9f9',
        tertiaryColor: '#ffffff',
        background: '#ffffff',
        mainBkg: '#ffffff',
        secondBkg: '#f9f9f9',
        tertiaryBkg: '#ffffff'
    },
    flowchart: {
        htmlLabels: true,
        curve: 'basis',
        useMaxWidth: true
    },
    sequence: {
        diagramMarginX: 50,
        diagramMarginY: 10,
        boxTextMargin: 5,
        noteMargin: 10,
        messageMargin: 35,
        useMaxWidth: true
    },
    gantt: {
        useMaxWidth: true
    }
});

// Apply additional styling fixes
document.addEventListener('DOMContentLoaded', function() {
    // Fix any remaining styling issues
    const style = document.createElement('style');
    style.textContent = `
        .mermaid {
            background: white !important;
            color: black !important;
        }
        .mermaid .node rect,
        .mermaid .node circle,
        .mermaid .node ellipse,
        .mermaid .node polygon {
            fill: #ffffff !important;
            stroke: #cccccc !important;
            color: #000000 !important;
        }
        .mermaid .node .label {
            color: #000000 !important;
        }
        .mermaid .edgePath .path {
            stroke: #666666 !important;
        }
        .mermaid .edgeLabel {
            background-color: #ffffff !important;
            color: #000000 !important;
        }
    `;
    document.head.appendChild(style);
});