function QRCodeGenerator(props) {
  const { React, useState, useEffect } = props;

  const [text, setText] = useState('');
  const [qrCodeUrl, setQrCodeUrl] = useState('');
  const [size, setSize] = useState(200);
  const [errorLevel, setErrorLevel] = useState('M');
  const [isLoading, setIsLoading] = useState(false);

  // Generate QR code using QR Server API
  const generateQRCode = (inputText, qrSize, level) => {
    if (!inputText.trim()) {
      setQrCodeUrl('');
      return;
    }

    setIsLoading(true);
    const encodedText = encodeURIComponent(inputText.trim());
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=${qrSize}x${qrSize}&data=${encodedText}&ecc=${level}`;

    // Simulate loading delay for better UX
    setTimeout(() => {
      setQrCodeUrl(url);
      setIsLoading(false);
    }, 300);
  };

  // Generate QR code when inputs change
  useEffect(() => {
    const debounceTimer = setTimeout(() => {
      generateQRCode(text, size, errorLevel);
    }, 500);

    return () => clearTimeout(debounceTimer);
  }, [text, size, errorLevel]);

  const downloadQRCode = async () => {
    if (!qrCodeUrl) return;

    try {
      const response = await fetch(qrCodeUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = `qr-code-${Date.now()}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Download failed:', error);
      alert('Failed to download QR code. Please try again.');
    }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(text);
      alert('Text copied to clipboard!');
    } catch (error) {
      console.error('Copy failed:', error);
      alert('Failed to copy text to clipboard.');
    }
  };

  const predefinedTexts = [
    'https://example.com',
    'Hello, World!',
    'mailto:contact@example.com',
    'tel:+1234567890',
    'WiFi:T:WPA;S:MyNetwork;P:MyPassword;;'
  ];

  return (
    <div className="max-w-4xl mx-auto p-6 bg-white rounded-lg shadow-lg">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">QR Code Generator</h1>
        <p className="text-gray-600">
          Generate QR codes for text, URLs, email addresses, and more!
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-8">
        {/* Input Section */}
        <div className="space-y-6">
          <div>
            <label htmlFor="text-input" className="block text-sm font-medium text-gray-700 mb-2">
              Enter text or URL
            </label>
            <textarea
              id="text-input"
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="Enter the text you want to encode..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              rows={4}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="size-select" className="block text-sm font-medium text-gray-700 mb-2">
                Size (pixels)
              </label>
              <select
                id="size-select"
                value={size}
                onChange={e => setSize(parseInt(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value={150}>150x150</option>
                <option value={200}>200x200</option>
                <option value={300}>300x300</option>
                <option value={400}>400x400</option>
                <option value={500}>500x500</option>
              </select>
            </div>

            <div>
              <label htmlFor="error-level" className="block text-sm font-medium text-gray-700 mb-2">
                Error Correction
              </label>
              <select
                id="error-level"
                value={errorLevel}
                onChange={e => setErrorLevel(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="L">Low (~7%)</option>
                <option value="M">Medium (~15%)</option>
                <option value="Q">Quartile (~25%)</option>
                <option value="H">High (~30%)</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Quick Examples</label>
            <div className="flex flex-wrap gap-2">
              {predefinedTexts.map((example, index) => (
                <button
                  key={index}
                  onClick={() => setText(example)}
                  className="px-3 py-1 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-full transition-colors"
                  title={`Click to use: ${example}`}
                >
                  {example.length > 20 ? `${example.substring(0, 20)}...` : example}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={copyToClipboard}
              disabled={!text.trim()}
              className="flex-1 px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            >
              Copy Text
            </button>
            <button
              onClick={() => setText('')}
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 transition-colors"
            >
              Clear
            </button>
          </div>
        </div>

        {/* QR Code Display Section */}
        <div className="space-y-6">
          <div className="text-center">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Generated QR Code</h3>

            <div className="relative inline-block">
              {isLoading ? (
                <div
                  className="flex items-center justify-center bg-gray-100 border-2 border-gray-200 rounded-lg"
                  style={{ width: size, height: size }}
                >
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                </div>
              ) : qrCodeUrl ? (
                <img
                  src={qrCodeUrl}
                  alt="Generated QR Code"
                  className="border-2 border-gray-200 rounded-lg shadow-md"
                  style={{ width: size, height: size }}
                />
              ) : (
                <div
                  className="flex items-center justify-center bg-gray-50 border-2 border-dashed border-gray-300 rounded-lg"
                  style={{ width: size, height: size }}
                >
                  <div className="text-center">
                    <svg
                      className="mx-auto h-12 w-12 text-gray-400"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                      ></path>
                    </svg>
                    <p className="text-sm text-gray-500 mt-2">Enter text to generate QR code</p>
                  </div>
                </div>
              )}
            </div>

            {qrCodeUrl && (
              <div className="mt-4 space-y-3">
                <button
                  onClick={downloadQRCode}
                  className="w-full px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                >
                  Download QR Code
                </button>

                <div className="text-xs text-gray-500 space-y-1">
                  <p>
                    Size: {size}×{size} pixels
                  </p>
                  <p>Error Correction: {errorLevel} Level</p>
                  <p>Characters: {text.length}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Usage Instructions */}
      <div className="mt-8 p-4 bg-blue-50 rounded-lg">
        <h4 className="font-semibold text-blue-900 mb-2">How to use:</h4>
        <ul className="text-sm text-blue-800 space-y-1">
          <li>• Enter any text, URL, email address, or phone number</li>
          <li>• Adjust the size and error correction level as needed</li>
          <li>• Click "Download QR Code" to save the image</li>
          <li>• Higher error correction levels help QR codes work even when partially damaged</li>
        </ul>
      </div>
    </div>
  );
}
