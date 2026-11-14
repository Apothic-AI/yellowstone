// Command cgo builds the C ABI of the SubRouter client.
//
//	go build -buildmode=c-shared -o libsubrouter.so ./bridge/cgo
//
// The ABI is three functions:
//
//	char *subrouterctl_call(const char *request);
//	void  subrouterctl_free(char *pointer);
//	const char *subrouterctl_version(void);
//
// A request is one JSON object with a method, optional parameters and
// optional options. The answer is one JSON object. The caller owns the
// answer and must release it with subrouterctl_free.
//
// The bindings use this to call the library in process, without a child
// process and without a copy of the API client in another language.
package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"encoding/json"
	"unsafe"

	"github.com/Apothic-AI/subrouterctl/pkg/service"
)

//export subrouterctl_call
func subrouterctl_call(request *C.char) (result *C.char) {
	defer func() {
		if r := recover(); r != nil {
			result = C.CString(`{"ok":false,"error":{"message":"the call panicked","type":"panic"}}`)
		}
	}()

	var req service.Request
	if request != nil {
		if err := json.Unmarshal([]byte(C.GoString(request)), &req); err != nil {
			return C.CString(`{"ok":false,"error":{"message":"invalid request","type":"invalid_request"}}`)
		}
	}

	resp := service.Dispatch(context.Background(), req)
	body, err := json.Marshal(resp)
	if err != nil {
		return C.CString(`{"ok":false,"error":{"message":"cannot encode the response","type":"encode"}}`)
	}
	return C.CString(string(body))
}

//export subrouterctl_free
func subrouterctl_free(pointer *C.char) {
	if pointer != nil {
		C.free(unsafe.Pointer(pointer))
	}
}

//export subrouterctl_version
func subrouterctl_version() *C.char {
	return C.CString(service.Version)
}

func main() {}
