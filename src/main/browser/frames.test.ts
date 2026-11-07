import { describe, expect, it } from 'vitest'
import { FRAME_MARK_RE, frameError, indentLines, isFrameRef, PageFrames, parseRef, prefixRefs } from './frames'
import { FRAME_MARK } from './page-scripts'

describe('refs of frames', () => {
  it('tells the frame and the ref in it apart', () => {
    expect(parseRef('f2e15')).toEqual({ frame: 2, local: 'e15' })
    expect(parseRef('e15')).toEqual({ frame: null, local: 'e15' })
    expect(isFrameRef('f1e5')).toBe(true)
    expect(isFrameRef('e5')).toBe(false)
  })

  it('gives the refs of a frame its number, but not those of deeper frames', () => {
    expect(prefixRefs('- button "Pay" [ref=e3]\n  - textbox [ref=f7e1]', 2)).toBe('- button "Pay" [ref=f2e3]\n  - textbox [ref=f7e1]')
  })

  it('names elements of a frame by their full ref in errors', () => {
    expect(frameError('Element e4 is gone. Take a new browser_snapshot.', 3)).toBe('Element f3e4 is gone. Take a new browser_snapshot.')
  })

  it('puts a frame one level below its iframe', () => {
    expect(indentLines('- Frame URL: https://pay.example/\n- button "Pay" [ref=f1e2]', '    ')).toBe(
      '    - Frame URL: https://pay.example/\n    - button "Pay" [ref=f1e2]',
    )
  })

  it('finds the marks the page script leaves for frames of other sites', () => {
    const text = `- main\n  - iframe "Payment" [ref=e9]\n    - ${FRAME_MARK}e9\n  - button "Back" [ref=e10]`
    const marks = [...text.matchAll(FRAME_MARK_RE)].map((m) => [m[1], m[2]])
    expect(marks).toEqual([['    ', 'e9']])
  })
})

describe('PageFrames', () => {
  it('keeps the number of a frame while the document stays, and never gives an old number again', () => {
    const frames = new PageFrames()
    frames.setDocument('doc1')
    const first = frames.record('FRAME-A', null, 'e9')
    expect(first.num).toBe(1)
    expect(frames.record('FRAME-A', null, 'e12').num).toBe(1)
    expect(frames.get(1)?.ownerRef).toBe('e12')

    frames.setDocument('doc2')
    expect(frames.get(1)).toBeUndefined()
    expect(frames.record('FRAME-A', null, 'e3').num).toBe(2)
  })

  it('reaches a frame in a process of its own by its session, others by their parent', () => {
    const frames = new PageFrames()
    frames.setDocument('doc')
    frames.attached('OOPIF', 'session-1')
    const own = frames.record('OOPIF', null, 'e1')
    expect(own.session).toBe('session-1')
    const inner = frames.record('INNER', own, 'e4')
    expect(inner.session).toBe('session-1')
    expect(inner.parent).toBe(own.num)
    expect(frames.record('SAME-PROCESS', null, 'e2').session).toBeUndefined()
    expect(frames.frameSessions()).toEqual(['session-1'])

    own.contextId = 7
    frames.detached('session-1')
    expect(own.contextId).toBeNull()
    expect(frames.frameSessions()).toEqual([])
  })
})
