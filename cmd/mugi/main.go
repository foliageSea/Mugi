// mugi — use Android apps in any browser, powered by scrcpy-server.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"flag"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/gin-gonic/gin"
	"mugi/internal/adb"
	"mugi/internal/scrcpy"
	"mugi/internal/server"
	"mugi/web"
)

// webFS serves the embedded frontend.
var webFS = http.FS(web.Assets)

func main() {
	gin.SetMode(gin.ReleaseMode)

	var (
		addr    = flag.String("addr", "127.0.0.1:8080", "listen address")
		tlsOn   = flag.Bool("tls", false, "serve HTTPS with a self-signed cert (required for WebCodecs on LAN)")
		certDir = flag.String("certdir", "", "directory to cache the self-signed certificate (default: ~/.mugi)")
		access  = flag.String("access", "auto", "client network policy: auto, local, or external")
	)
	flag.Parse()

	manager := scrcpy.NewManager()

	adbClient, err := adb.New()
	if err != nil {
		log.Fatalf("%v\nHint: brew install android-platform-tools / sudo apt install adb", err)
	}
	backend := scrcpy.NewAdbBackend(adbClient, manager)

	srv := server.NewWithAccessMode(backend, manager, server.AccessMode(*access))
	handler := srv.Router(webFS)

	httpSrv := &http.Server{
		Addr:    *addr,
		Handler: handler,
	}

	scheme := "http"
	if *tlsOn {
		cert, err := loadOrCreateCert(*certDir)
		if err != nil {
			log.Fatalf("tls: %v", err)
		}
		httpSrv.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}}
		scheme = "https"
	}

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("mugi listening on %s://%s", scheme, *addr)
	log.Printf("Open %s://localhost%s in Chrome/Edge (WebCodecs requires a secure context)",
		scheme, portSuffix(*addr))
	if *tlsOn {
		log.Fatal(httpSrv.ServeTLS(ln, "", ""))
	}
	log.Fatal(httpSrv.Serve(ln))
}

func portSuffix(addr string) string {
	_, port, err := net.SplitHostPort(addr)
	if err != nil || port == "80" {
		return ""
	}
	return ":" + port
}

func loadOrCreateCert(dir string) (tls.Certificate, error) {
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".mugi")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return tls.Certificate{}, err
	}
	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")
	if _, err := os.Stat(certPath); err == nil {
		return tls.LoadX509KeyPair(certPath, keyPath)
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	tmpl := x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "mugi Local"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(5, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}
	// Add LAN IPs so the cert also works from other machines.
	if ifaces, err := net.InterfaceAddrs(); err == nil {
		for _, a := range ifaces {
			if ipnet, ok := a.(*net.IPNet); ok && ipnet.IP.IsPrivate() {
				tmpl.IPAddresses = append(tmpl.IPAddresses, ipnet.IP)
			}
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	certOut, err := os.Create(certPath)
	if err != nil {
		return tls.Certificate{}, err
	}
	_ = pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: der})
	certOut.Close()

	keyBytes, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyOut, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return tls.Certificate{}, err
	}
	_ = pem.Encode(keyOut, &pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes})
	keyOut.Close()
	log.Printf("Generated self-signed certificate in %s (accept the browser warning once)", dir)
	return tls.LoadX509KeyPair(certPath, keyPath)
}
