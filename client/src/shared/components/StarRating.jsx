import { useState, useCallback } from 'react';
import { StarIcon } from '@heroicons/react/24/solid';
import { StarIcon as StarOutlineIcon } from '@heroicons/react/24/outline';

const StarRating = ({
  rating = 0,
  onRatingChange,
  readonly = false,
  size = 'w-5 h-5',
  allowHalfStars = true,
  maxStars = 5,
  showTooltip = true,
  className = ''
}) => {
  const [hoverRating, setHoverRating] = useState(0);

  const handleStarClick = useCallback(
    (starIndex, event) => {
      if (readonly) return;

      let newRating = starIndex + 1;

      if (allowHalfStars) {
        // Calculate position within star for half-star support
        const rect = event.currentTarget.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const starWidth = rect.width;
        const isLeftHalf = x < starWidth / 2;

        newRating = isLeftHalf ? starIndex + 0.5 : starIndex + 1;
      }

      onRatingChange?.(newRating);
    },
    [readonly, onRatingChange, allowHalfStars]
  );

  const handleStarHover = useCallback(
    (starIndex, event) => {
      if (readonly) return;

      if (!allowHalfStars) {
        setHoverRating(starIndex + 1);
        return;
      }

      // Calculate position within star for half-star support
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const starWidth = rect.width;
      const isLeftHalf = x < starWidth / 2;

      const newHoverRating = isLeftHalf ? starIndex + 0.5 : starIndex + 1;
      setHoverRating(newHoverRating);
    },
    [readonly, allowHalfStars]
  );

  const handleMouseLeave = useCallback(() => {
    if (!readonly) {
      setHoverRating(0);
    }
  }, [readonly]);

  const getStarFillType = starIndex => {
    const currentRating = hoverRating || rating;
    const starValue = starIndex + 1;

    if (currentRating >= starValue) {
      return 'full';
    } else if (allowHalfStars && currentRating >= starValue - 0.5) {
      return 'half';
    }
    return 'empty';
  };

  const getTooltipText = starIndex => {
    if (!showTooltip) return '';

    const starValue = starIndex + 1;
    const ratingLabels = {
      1: 'Poor',
      2: 'Fair',
      3: 'Good',
      4: 'Very Good',
      5: 'Excellent'
    };

    return ratingLabels[starValue] || `${starValue} stars`;
  };

  const renderStar = starIndex => {
    const fillType = getStarFillType(starIndex);
    const isHovering = !readonly && hoverRating > 0;

    return (
      <div
        key={starIndex}
        className={`relative cursor-pointer ${readonly ? 'cursor-default' : ''}`}
        onClick={e => handleStarClick(starIndex, e)}
        onMouseMove={e => handleStarHover(starIndex, e)}
        title={getTooltipText(starIndex)}
      >
        {/* Base star (outline) */}
        <StarOutlineIcon className={`${size} text-gray-300 transition-colors duration-150`} />

        {/* Filled star overlay */}
        <div
          className="absolute top-0 left-0 overflow-hidden transition-all duration-150"
          style={{
            width: fillType === 'half' ? '50%' : fillType === 'full' ? '100%' : '0%'
          }}
        >
          <StarIcon
            className={`${size} transition-colors duration-150 ${
              isHovering ? 'text-yellow-400' : 'text-yellow-500'
            }`}
          />
        </div>
      </div>
    );
  };

  return (
    <div className={`flex items-center space-x-1 ${className}`} onMouseLeave={handleMouseLeave}>
      {Array.from({ length: maxStars }, (_, index) => renderStar(index))}

      {/* Rating display */}
      {(rating > 0 || hoverRating > 0) && (
        <span className="ml-2 text-sm text-gray-600 font-medium">
          {(hoverRating || rating).toFixed(allowHalfStars ? 1 : 0)} / {maxStars}
        </span>
      )}
    </div>
  );
};

export default StarRating;
