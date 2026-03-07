import { channelImageIcons } from '@/assets/channels';
import { CHANNEL_ICONS, type ChannelType } from '@/types/channel';

interface ChannelIconProps {
  type: ChannelType;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

const sizeMap = {
  sm: 'w-5 h-5',
  md: 'w-7 h-7',
  lg: 'w-9 h-9',
};

const emojiSizeMap = {
  sm: 'text-lg',
  md: 'text-2xl',
  lg: 'text-3xl',
};

export function ChannelIcon({ type, className = '', size = 'md' }: ChannelIconProps) {
  const imageIcon = channelImageIcons[type];

  if (imageIcon) {
    return <img src={imageIcon} alt={type} className={`${sizeMap[size]} ${className}`} />;
  }

  return <span className={`${emojiSizeMap[size]} ${className}`}>{CHANNEL_ICONS[type]}</span>;
}
