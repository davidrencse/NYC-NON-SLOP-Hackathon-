import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Group, Vector3 } from 'three'

// Static scene tags need no nested React root (Drei Html synchronously unmounts one during scene commits).
export function SceneLabel({ position, fields, className, visible = true }: {
  position: [number, number, number]; fields: [string, string, string]; className: string; visible?: boolean
}) {
  const anchor = useRef<Group>(null)
  const element = useRef<HTMLDivElement | null>(null)
  const { gl, camera, size } = useThree()
  const point = useRef(new Vector3())
  const [number, title, subtitle] = fields
  useEffect(() => {
    const tag = document.createElement('div')
    tag.style.cssText = 'position:absolute;pointer-events:none;z-index:20;'
    for (const [text, css] of [[number, 'forge-tag-n'], [title, ''], [subtitle, 'forge-tag-sub']]) {
      const span = document.createElement('span'); span.textContent = text; span.className = css; tag.append(span)
    }
    gl.domElement.parentElement!.append(tag); element.current = tag
    return () => { tag.remove(); element.current = null }
  }, [gl, number, title, subtitle])
  useFrame(() => {
    if (!anchor.current || !element.current) return
    anchor.current.getWorldPosition(point.current).project(camera)
    const tag = element.current
    tag.className = className
    tag.style.display = visible && point.current.z < 1 && point.current.z > -1 ? '' : 'none'
    tag.style.transform = `translate(${(point.current.x + 1) * size.width / 2}px,${(1 - point.current.y) * size.height / 2}px) translate(-50%,-50%)`
  })
  return <group ref={anchor} position={position} />
}
