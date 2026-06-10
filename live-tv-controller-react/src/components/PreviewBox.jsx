
import React, { useEffect, useRef, useState } from 'react';
import { useOBS } from '../context/OBSContext';

const PreviewBox = () => {
    const { virtualCamActive } = useOBS();
    const videoRef = useRef(null);
    const [errorMsg, setErrorMsg] = useState("");
    const [showPreview, setShowPreview] = useState(false);

    useEffect(() => {
        let stream = null;

        const startPreview = async () => {
            if (!virtualCamActive || !showPreview) {
                if (videoRef.current && videoRef.current.srcObject) {
                    videoRef.current.srcObject.getTracks().forEach(t => t.stop());
                    videoRef.current.srcObject = null;
                }
                return;
            }

            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                const obsCamera = devices.find(d => d.kind === 'videoinput' && d.label.includes("OBS Virtual Camera"));

                if (obsCamera) {
                    stream = await navigator.mediaDevices.getUserMedia({
                        video: {
                            deviceId: { exact: obsCamera.deviceId },
                            width: { ideal: 240 },
                            height: { ideal: 135 }
                        },
                        audio: false
                    });
                    if (videoRef.current) {
                        videoRef.current.srcObject = stream;
                        setErrorMsg("");
                    }
                } else {
                    setErrorMsg('VCam not found');
                }
            } catch (err) {
                console.error("Camera Error:", err);
                setErrorMsg(err.message.slice(0, 20));
            }
        };

        startPreview();

        return () => {
            if (stream) {
                stream.getTracks().forEach(t => t.stop());
            }
        };
    }, [virtualCamActive, showPreview]);

    const togglePreview = () => {
        setShowPreview(!showPreview);
    };

    return (
        <div className="flex flex-col items-center gap-1">
            <div className="relative w-[200px] h-[112px] bg-gray-900 rounded-lg overflow-hidden border-2 border-gray-600">
                <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    className="w-full h-full object-cover"
                />
                {!showPreview && (
                    <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm bg-gray-900/80">
                        📺 Preview Off
                    </div>
                )}
            </div>
            <button
                onClick={togglePreview}
                className={`px-2 py-0.5 rounded text-xs font-medium transition-all ${showPreview && videoRef.current?.srcObject
                    ? 'bg-cyan-600 text-white'
                    : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                    }`}
            >
                {showPreview ? "Hide" : "Show"}
            </button>
            {errorMsg && <p className="text-red-400 text-xs">{errorMsg}</p>}
        </div>
    );
};

export default PreviewBox;

