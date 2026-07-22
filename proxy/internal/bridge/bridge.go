package bridge

import (
	"io"
	"sync"
	"sync/atomic"
)

// ByteCounter tracks bytes flowing through the bridge.
type ByteCounter struct {
	In  atomic.Int64
	Out atomic.Int64
}

type countingWriter struct {
	w       io.Writer
	counter *atomic.Int64
}

func (cw *countingWriter) Write(p []byte) (int, error) {
	n, err := cw.w.Write(p)
	cw.counter.Add(int64(n))
	return n, err
}

// Bridge forwards bytes bidirectionally between a TCP connection and a WebTransport stream.
type Bridge struct {
	tcp     io.ReadWriteCloser
	wt      io.ReadWriteCloser
	done    chan struct{}
	once    sync.Once
	Counter ByteCounter
}

// New creates a Bridge between two ReadWriteClosers and starts forwarding.
func New(tcp io.ReadWriteCloser, wt io.ReadWriteCloser) *Bridge {
	b := &Bridge{
		tcp:  tcp,
		wt:   wt,
		done: make(chan struct{}),
	}
	// tcp→wt = bytes "in" from MC client, wt→tcp = bytes "out" to MC client
	go b.forward(&countingWriter{w: wt, counter: &b.Counter.In}, tcp)
	go b.forward(&countingWriter{w: tcp, counter: &b.Counter.Out}, wt)
	return b
}

// NewWithCounters creates a Bridge that writes byte counts to external atomic counters
// (owned by metrics) instead of internal ones.
func NewWithCounters(tcp, wt io.ReadWriteCloser, inCounter, outCounter *atomic.Int64) *Bridge {
	b := &Bridge{
		tcp:  tcp,
		wt:   wt,
		done: make(chan struct{}),
	}
	go b.forward(&countingWriter{w: wt, counter: inCounter}, tcp)
	go b.forward(&countingWriter{w: tcp, counter: outCounter}, wt)
	return b
}

func (b *Bridge) forward(dst io.Writer, src io.Reader) {
	io.Copy(dst, src)
	b.Close()
}

// Done returns a channel that is closed when the bridge shuts down.
func (b *Bridge) Done() <-chan struct{} {
	return b.done
}

// Close shuts down both connections and signals done.
func (b *Bridge) Close() {
	b.once.Do(func() {
		b.tcp.Close()
		b.wt.Close()
		close(b.done)
	})
}
