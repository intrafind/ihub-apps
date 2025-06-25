import React, { useState } from 'react';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
  CameraIcon,
  ChatBubbleLeftRightIcon,
  CheckIcon as OutlineCheckIcon,
  CheckCircleIcon as OutlineCheckCircleIcon,
  ClipboardIcon,
  PencilSquareIcon,
  PencilIcon,
  ArrowPathIcon,
  TrashIcon as OutlineTrashIcon,
  HandThumbUpIcon as OutlineHandThumbUpIcon,
  HandThumbDownIcon as OutlineHandThumbDownIcon,
  QuestionMarkCircleIcon as OutlineQuestionMarkCircleIcon,
  GlobeAltIcon,
  SparklesIcon as OutlineSparklesIcon,
  EnvelopeIcon as OutlineEnvelopeIcon,
  CalendarIcon as OutlineCalendarIcon,
  ShareIcon as OutlineShareIcon,
  DocumentMagnifyingGlassIcon as OutlineDocumentMagnifyingGlassIcon,
  UsersIcon as OutlineUsersIcon,
  LightBulbIcon as OutlineLightBulbIcon,
  CodeBracketIcon as OutlineCodeBracketIcon,
  ClockIcon,
  XMarkIcon,
  DocumentTextIcon as OutlineDocumentTextIcon,
  PaperClipIcon as OutlinePaperClipIcon,
  MicrophoneIcon as OutlineMicrophoneIcon,
  MagnifyingGlassIcon,
  InformationCircleIcon as OutlineInformationCircleIcon,
  Cog6ToothIcon,
  AdjustmentsHorizontalIcon,
  StarIcon as OutlineStarIcon,
  XCircleIcon,
  UserIcon,
  ExclamationCircleIcon as OutlineExclamationCircleIcon,
  ExclamationTriangleIcon as OutlineExclamationTriangleIcon,
  AcademicCapIcon as OutlineAcademicCapIcon,
  ListBulletIcon,
  PlusCircleIcon,
  MinusCircleIcon,
  SwatchIcon,
  BriefcaseIcon,
  PaintBrushIcon,
  Bars3Icon,
  FaceFrownIcon as OutlineFaceFrownIcon
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
  ExclamationCircleIcon as SolidExclamationCircleIcon,
  ExclamationTriangleIcon as SolidExclamationTriangleIcon,
  QuestionMarkCircleIcon as SolidQuestionMarkCircleIcon,
  GlobeAltIcon as SolidGlobeAltIcon,
  SparklesIcon as SolidSparklesIcon,
  EnvelopeIcon as SolidEnvelopeIcon,
  CalendarIcon as SolidCalendarIcon,
  ShareIcon as SolidShareIcon,
  DocumentMagnifyingGlassIcon as SolidDocumentMagnifyingGlassIcon,
  UsersIcon as SolidUsersIcon,
  LightBulbIcon as SolidLightBulbIcon,
  CodeBracketIcon as SolidCodeBracketIcon,
  ClockIcon as SolidClockIcon,
  AcademicCapIcon as SolidAcademicCapIcon,
  InformationCircleIcon as SolidInformationCircleIcon,
  PlusCircleIcon as SolidPlusCircleIcon,
  MinusCircleIcon as SolidMinusCircleIcon,
  SwatchIcon as SolidSwatchIcon,
  BriefcaseIcon as SolidBriefcaseIcon,
  PaintBrushIcon as SolidPaintBrushIcon,
  FaceFrownIcon as SolidFaceFrownIcon
} from '@heroicons/react/24/solid';

const iconMap = {
  arrowLeft: { outline: ArrowLeftIcon, solid: ArrowLeftIcon },
  'arrow-right': { outline: ArrowRightIcon, solid: ArrowRightIcon },
  undo: { outline: ArrowUturnLeftIcon, solid: ArrowUturnLeftIcon },
  redo: { outline: ArrowUturnRightIcon, solid: ArrowUturnRightIcon },
  camera: { outline: CameraIcon, solid: SolidCameraIcon },
  chat: { outline: ChatBubbleLeftRightIcon, solid: ChatBubbleLeftRightIcon },
  check: { outline: OutlineCheckIcon, solid: SolidCheckIcon },
  'check-circle': { outline: OutlineCheckCircleIcon, solid: SolidCheckCircleIcon },
  clearCircle: { outline: XCircleIcon, solid: XCircleIcon },
  close: { outline: XMarkIcon, solid: XMarkIcon },
  cog: { outline: Cog6ToothIcon, solid: Cog6ToothIcon },
  'color-swatch': { outline: SwatchIcon, solid: SolidSwatchIcon },
  copy: { outline: ClipboardIcon, solid: ClipboardIcon },
  'document-text': { outline: OutlineDocumentTextIcon, solid: SolidDocumentTextIcon },
  edit: { outline: PencilSquareIcon, solid: PencilSquareIcon },
  'exclamation-circle': { outline: OutlineExclamationCircleIcon, solid: SolidExclamationCircleIcon },
  'exclamation-triangle': { outline: OutlineExclamationTriangleIcon, solid: SolidExclamationTriangleIcon },
  'face-frown': { outline: OutlineFaceFrownIcon, solid: SolidFaceFrownIcon },
  format: { outline: Bars3Icon, solid: Bars3Icon },
  'information-circle': { outline: OutlineInformationCircleIcon, solid: SolidInformationCircleIcon },
  list: { outline: ListBulletIcon, solid: ListBulletIcon },
  menu: { outline: Bars3Icon, solid: Bars3Icon },
  microphone: { outline: OutlineMicrophoneIcon, solid: SolidMicrophoneIcon },
  'minus-circle': { outline: MinusCircleIcon, solid: SolidMinusCircleIcon },
  'paint-brush': { outline: PaintBrushIcon, solid: SolidPaintBrushIcon },
  'paper-clip': { outline: OutlinePaperClipIcon, solid: SolidPaperClipIcon },
  pencil: { outline: PencilIcon, solid: PencilIcon },
  'plus-circle': { outline: PlusCircleIcon, solid: SolidPlusCircleIcon },
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
  'question-mark-circle': {
    outline: OutlineQuestionMarkCircleIcon,
    solid: SolidQuestionMarkCircleIcon,
  },
  'chat-bubbles': { outline: ChatBubbleLeftRightIcon, solid: ChatBubbleLeftRightIcon },
  globe: { outline: GlobeAltIcon, solid: SolidGlobeAltIcon },
  sparkles: { outline: OutlineSparklesIcon, solid: SolidSparklesIcon },
  mail: { outline: OutlineEnvelopeIcon, solid: SolidEnvelopeIcon },
  calendar: { outline: OutlineCalendarIcon, solid: SolidCalendarIcon },
  share: { outline: OutlineShareIcon, solid: SolidShareIcon },
  'document-search': {
    outline: OutlineDocumentMagnifyingGlassIcon,
    solid: SolidDocumentMagnifyingGlassIcon,
  },
  users: { outline: OutlineUsersIcon, solid: SolidUsersIcon },
  'light-bulb': { outline: OutlineLightBulbIcon, solid: SolidLightBulbIcon },
  code: { outline: OutlineCodeBracketIcon, solid: SolidCodeBracketIcon },
  clock: { outline: ClockIcon, solid: SolidClockIcon },
  'academic-cap': { outline: OutlineAcademicCapIcon, solid: SolidAcademicCapIcon },
  briefcase: { outline: BriefcaseIcon, solid: SolidBriefcaseIcon },
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
