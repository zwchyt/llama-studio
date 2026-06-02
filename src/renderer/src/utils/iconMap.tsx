import React from 'react'
import { Box, Cpu, Zap, Database, Sliders, Wind, Server, FileText, GitBranch, Star, Settings } from 'lucide-react'

export const iconComponents: Record<string, React.ElementType> = {
  Box, Cpu, Zap, Database, Sliders, Wind, Server, FileText, GitBranch, Star, Settings
}

export const iconElements: Record<string, React.ReactNode> = {
  Box: <Box size={14} />,
  Cpu: <Cpu size={14} />,
  Zap: <Zap size={14} />,
  Database: <Database size={14} />,
  Sliders: <Sliders size={14} />,
  Wind: <Wind size={14} />,
  Server: <Server size={14} />,
  FileText: <FileText size={14} />,
  GitBranch: <GitBranch size={14} />,
  Star: <Star size={14} />,
  Settings: <Settings size={14} />
}

export const ICON_NAMES = Object.keys(iconComponents)
