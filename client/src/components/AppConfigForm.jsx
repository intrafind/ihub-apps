import React from 'react';

const AppConfigForm = ({ 
  app, 
  models, 
  styles, 
  selectedModel, 
  selectedStyle, 
  temperature,
  onModelChange, 
  onStyleChange, 
  onTemperatureChange 
}) => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {/* Model Selection */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Model
        </label>
        <select
          value={selectedModel}
          onChange={(e) => onModelChange(e.target.value)}
          className="w-full p-2 border rounded focus:ring-indigo-500 focus:border-indigo-500"
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </div>
      
      {/* Style Selection */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Response Style
        </label>
        <select
          value={selectedStyle}
          onChange={(e) => onStyleChange(e.target.value)}
          className="w-full p-2 border rounded focus:ring-indigo-500 focus:border-indigo-500"
        >
          {Object.entries(styles).map(([id, description]) => (
            <option key={id} value={id}>
              {id.charAt(0).toUpperCase() + id.slice(1)}
            </option>
          ))}
        </select>
      </div>
      
      {/* Temperature */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Temperature: {temperature}
        </label>
        <input
          type="range"
          min="0"
          max="1"
          step="0.1"
          value={temperature}
          onChange={(e) => onTemperatureChange(parseFloat(e.target.value))}
          className="w-full"
        />
        <div className="flex justify-between text-xs text-gray-500">
          <span>Precise</span>
          <span>Creative</span>
        </div>
      </div>
    </div>
  );
};

export default AppConfigForm; 