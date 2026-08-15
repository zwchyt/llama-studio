import React from 'react'
import {
  BoxIcon,
  CpuIcon,
  ZapIcon,
  SlidersHorizontalIcon,
  WindIcon,
  ServerIcon,
  FileTextIcon,
  GitBranchIcon,
  StarIcon,
  SettingsIcon,
  MemoryStickIcon,
  TimerIcon,
  SparklesIcon,
  ImageIcon,
  ShieldCheckIcon,
  ChartNetworkIcon
} from '@animateicons/react/lucide'

export const iconComponents: Record<string, React.ElementType> = {
  Box: BoxIcon,
  Cpu: CpuIcon,
  Zap: ZapIcon,
  Sliders: SlidersHorizontalIcon,
  Wind: WindIcon,
  Server: ServerIcon,
  FileText: FileTextIcon,
  GitBranch: GitBranchIcon,
  Star: StarIcon,
  Settings: SettingsIcon,
  Database: MemoryStickIcon,
  Gauge: TimerIcon,
  Sparkles: SparklesIcon,
  Image: ImageIcon,
  Shield: ShieldCheckIcon,
  Network: ChartNetworkIcon
}

export const iconElements: Record<string, React.ReactNode> = {
  Box: <BoxIcon size={14} className="nav-animate-icon" />,
  Cpu: <CpuIcon size={14} className="nav-animate-icon" />,
  Zap: <ZapIcon size={14} className="nav-animate-icon" />,
  Sliders: <SlidersHorizontalIcon size={14} className="nav-animate-icon" />,
  Wind: <WindIcon size={14} className="nav-animate-icon" />,
  Server: <ServerIcon size={14} className="nav-animate-icon" />,
  FileText: <FileTextIcon size={14} className="nav-animate-icon" />,
  GitBranch: <GitBranchIcon size={14} className="nav-animate-icon" />,
  Star: <StarIcon size={14} className="nav-animate-icon" />,
  Settings: <SettingsIcon size={14} className="nav-animate-icon" />,
  Database: <MemoryStickIcon size={14} className="nav-animate-icon" />,
  Gauge: <TimerIcon size={14} className="nav-animate-icon" />,
  Sparkles: <SparklesIcon size={14} className="nav-animate-icon" />,
  Image: <ImageIcon size={14} className="nav-animate-icon" />,
  Shield: <ShieldCheckIcon size={14} className="nav-animate-icon" />,
  Network: <ChartNetworkIcon size={14} className="nav-animate-icon" />
}

export const ICON_NAMES = Object.keys(iconComponents)
