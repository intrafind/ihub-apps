import React, { useState } from 'react';
import {
  ArrowLeftIcon,
  CameraIcon,
  ChatBubbleLeftRightIcon,
  CheckIcon as OutlineCheckIcon,
  CheckCircleIcon as OutlineCheckCircleIcon,
  ClipboardIcon,
  PencilSquareIcon,
  ArrowPathIcon,
  TrashIcon as OutlineTrashIcon,
  HandThumbUpIcon as OutlineHandThumbUpIcon,
  HandThumbDownIcon as OutlineHandThumbDownIcon,
  XMarkIcon,
  DocumentTextIcon as OutlineDocumentTextIcon,
  PaperClipIcon as OutlinePaperClipIcon,
  MicrophoneIcon as OutlineMicrophoneIcon,
  MagnifyingGlassIcon,
  Cog6ToothIcon,
  AdjustmentsHorizontalIcon,
  StarIcon as OutlineStarIcon,
  XCircleIcon,
  UserIcon,
  ExclamationCircleIcon as OutlineExclamationCircleIcon
} from '@heroicons/react/24/outline';
import {
  CameraIcon as SolidCameraIcon,
  CheckIcon as SolidCheckIcon,
  CheckCircleIcon as SolidCheckCircleIcon,
  TrashIcon as SolidTrashIcon,
  HandThumbUpIcon as SolidHandThumbUpIcon,
  HandThumbDownIcon as SolidHandThumbDownIcon,
  DocumentTextIcon as SolidDocumentTextIcon,
  PaperClipIcon as SolidPaperClipIcon,
  MicrophoneIcon as SolidMicrophoneIcon,
  StarIcon as SolidStarIcon,
  ExclamationCircleIcon as SolidExclamationCircleIcon
} from '@heroicons/react/24/solid';

const iconMap = {
  arrowLeft: { outline: ArrowLeftIcon, solid: ArrowLeftIcon },
  camera: { outline: CameraIcon, solid: SolidCameraIcon },
  chat: { outline: ChatBubbleLeftRightIcon, solid: ChatBubbleLeftRightIcon },
  check: { outline: OutlineCheckIcon, solid: SolidCheckIcon },
  'check-circle': { outline: OutlineCheckCircleIcon, solid: SolidCheckCircleIcon },
  clearCircle: { outline: XCircleIcon, solid: XCircleIcon },
  close: { outline: XMarkIcon, solid: XMarkIcon },
  copy: { outline: ClipboardIcon, solid: ClipboardIcon },
  'document-text': { outline: OutlineDocumentTextIcon, solid: SolidDocumentTextIcon },
  edit: { outline: PencilSquareIcon, solid: PencilSquareIcon },
  'exclamation-circle': { outline: OutlineExclamationCircleIcon, solid: SolidExclamationCircleIcon },
  microphone: { outline: OutlineMicrophoneIcon, solid: SolidMicrophoneIcon },
  'paper-clip': { outline: OutlinePaperClipIcon, solid: SolidPaperClipIcon },
  refresh: { outline: ArrowPathIcon, solid: ArrowPathIcon },
  search: { outline: MagnifyingGlassIcon, solid: MagnifyingGlassIcon },
  settings: { outline: Cog6ToothIcon, solid: Cog6ToothIcon },
  sliders: { outline: AdjustmentsHorizontalIcon, solid: AdjustmentsHorizontalIcon },
  star: { outline: OutlineStarIcon, solid: SolidStarIcon },
  trash: { outline: OutlineTrashIcon, solid: SolidTrashIcon },
  user: { outline: UserIcon, solid: UserIcon },
  x: { outline: XMarkIcon, solid: XMarkIcon },
  'thumbs-up': { outline: OutlineHandThumbUpIcon, solid: SolidHandThumbUpIcon },
  'thumbs-down': { outline: OutlineHandThumbDownIcon, solid: SolidHandThumbDownIcon },
};

const sizeClasses = {
  xs: 'w-3 h-3',
  sm: 'w-4 h-4',
  md: 'w-5 h-5',
  lg: 'w-6 h-6',
  xl: 'w-8 h-8',
  '2xl': 'w-12 h-12',
};

const iconBaseUrl = import.meta.env.VITE_ICON_BASE_URL || '/icons';

const Icon = ({ name, size = 'md', className = '', solid = false }) => {
  const [imgError, setImgError] = useState(false);

  if (name === 'apps-svg-logo') {
    return <img src="/logo.png" alt="logo" className={`${sizeClasses[size] || sizeClasses.md} ${className}`} />;
  }

  const iconEntry = iconMap[name];
  if (iconEntry) {
    const IconComponent = solid ? iconEntry.solid : iconEntry.outline;
    return <IconComponent className={`${sizeClasses[size] || sizeClasses.md} ${className}`} />;
  }

  if (imgError) return null;

  return (
    <img
      src={`${iconBaseUrl}/${name}.svg`}
      alt={name}
      onError={() => setImgError(true)}
      className={`${sizeClasses[size] || sizeClasses.md} ${className}`}
    />
  );
};

export default Icon;
